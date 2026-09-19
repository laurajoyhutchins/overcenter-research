(defpackage :overcenter-semantic-macros
  (:use :cl)
  (:export :compile-declaration-string
           :compile-verifier-ir
           :defverifier))

(in-package :overcenter-semantic-macros)

(defun fail (code &optional detail)
  (error (if detail
             (format nil "~A:~A" code detail)
             code)))

(defun clause (name clauses)
  (let ((hits (remove-if-not
                (lambda (form)
                  (and (consp form) (eq (car form) name)))
                clauses)))
    (cond
      ((null hits) (fail "MISSING_FORM" (string-downcase (symbol-name name))))
      ((cdr hits) (fail "DUPLICATE_FORM" (string-downcase (symbol-name name))))
      (t (cdar hits)))))

(defun field-names-with-role (fields role)
  (loop for (name type roles) in fields
        declare (ignore type)
        when (member role roles)
          collect name))

(defun compile-verifier-ir (name clauses)
  (let ((allowed '(fields observes absence effect settlement verify)))
    (dolist (form clauses)
      (unless (and (consp form) (member (car form) allowed))
        (fail "UNKNOWN_FORM"
              (if (consp form)
                  (string-downcase (symbol-name (car form)))
                  (prin1-to-string form))))))

  (let* ((raw-fields (clause 'fields clauses))
         (fields
           (loop for form in raw-fields collect
             (progn
               (unless (and (listp form) (>= (length form) 3))
                 (fail "INVALID_FIELD"))
               (destructuring-bind (field-name field-type &rest roles) form
                 (dolist (role roles)
                   (unless (member role '(coordinate desired output context))
                     (fail "INVALID_FIELD_ROLE"
                           (string-downcase (symbol-name role)))))
                 (unless (= (length roles)
                            (length (remove-duplicates roles)))
                   (fail "DUPLICATE_FIELD_ROLE"
                         (string-downcase (symbol-name field-name))))
                 (list field-name field-type roles)))))
         (field-names (mapcar #'first fields))
         (coordinates (field-names-with-role fields 'coordinate))
         (desired (field-names-with-role fields 'desired))
         (outputs (field-names-with-role fields 'output))
         (raw-observes (clause 'observes clauses))
         (observations
           (loop for form in raw-observes collect
             (progn
               (unless (and (listp form) (= (length form) 2))
                 (fail "INVALID_OBSERVATION"))
               (first form))))
         (absence-form (clause 'absence clauses))
         (effect-form (clause 'effect clauses))
         (settlement-form (clause 'settlement clauses))
         (verify-form (clause 'verify clauses)))

    (unless (= (length field-names)
               (length (remove-duplicates field-names)))
      (fail "DUPLICATE_FIELD"))
    (when (null coordinates)
      (fail "NO_COORDINATE_FIELDS"))
    (unless (= (length desired) 1)
      (fail "EXPECTED_ONE_DESIRED_FIELD"))
    (unless (= (length outputs) 1)
      (fail "EXPECTED_ONE_OUTPUT_FIELD"))

    (unless (= (length absence-form) 1)
      (fail "INVALID_ABSENCE"))
    (let* ((absence-kind (first absence-form))
           (absence
             (unless (eq absence-kind 'none)
               (list :evidence-kind absence-kind
                     :subject-fields coordinates
                     :scope-fields coordinates)))
           (effect
             (cond
               ((equal effect-form '(none))
                (list :kind 'none))
               ((and (= (length effect-form) 3)
                     (eq (first effect-form) 'same-coordinate)
                     (eq (second effect-form) 'commutes)
                     (member (third effect-form) '(true false)))
                (list :kind 'same-coordinate
                      :resource-fields coordinates
                      :desired-field (first desired)
                      :same-desired-commutes (eq (third effect-form) 'true)))
               (t (fail "INVALID_EFFECT"))))
           (settlement
             (progn
               (unless (= (length settlement-form) 1)
                 (fail "INVALID_SETTLEMENT"))
               (first settlement-form))))

      (unless (member settlement
                      '(present-only present-or-declared-absence))
        (fail "INVALID_SETTLEMENT_POLICY"
              (string-downcase (symbol-name settlement))))
      (when (and absence (eq settlement 'present-only))
        (fail "DECLARED_ABSENCE_UNUSED_BY_SETTLEMENT"))
      (when (and (null absence)
                 (eq settlement 'present-or-declared-absence))
        (fail "SETTLEMENT_REQUIRES_DECLARED_ABSENCE"))

      (unless (and (= (length verify-form) 3)
                   (eq (first verify-form) 'eq)
                   (eq (third verify-form) 'desired))
        (fail "INVALID_VERIFY"))
      (unless (member (second verify-form) observations)
        (fail "UNKNOWN_VERIFY_OBSERVATION"
              (string-downcase
                (symbol-name (second verify-form)))))

      (list
        :verifier name
        :fields fields
        :coordinate-fields coordinates
        :output (list :selector 'verified-content
                      :field (first outputs))
        :absence absence
        :effect effect
        :settlement settlement
        :verification
          (list :op 'eq
                :left-observation (second verify-form)
                :right-field (first desired))))))

(defmacro defverifier (name &body clauses)
  (let ((ir (compile-verifier-ir name clauses)))
    `(defparameter
         ,(intern (format nil "*~A*" (symbol-name name))
                  *package*)
       ',ir)))

(defun read-one-declaration (source)
  (let ((*read-eval* nil)
        (*readtable* (copy-readtable nil))
        (*package* (find-package :overcenter-semantic-macros)))
    (with-input-from-string (stream source)
      (let ((form (read stream nil :eof))
            (extra nil))
        (when (eq form :eof)
          (fail "EMPTY_SOURCE"))
        (setf extra (read stream nil :eof))
        (unless (eq extra :eof)
          (fail "MULTIPLE_TOP_LEVEL_FORMS"))
        form))))

(defun compile-declaration-string (source)
  (let ((form (read-one-declaration source)))
    (unless (and (consp form) (eq (car form) 'defverifier))
      (fail "TOP_LEVEL_FORM_NOT_ALLOWED"))
    (let ((expanded (macroexpand-1 form)))
      (unless (and (consp expanded)
                   (eq (first expanded) 'defparameter)
                   (= (length expanded) 3)
                   (consp (third expanded))
                   (eq (first (third expanded)) 'quote))
        (fail "UNEXPECTED_MACRO_EXPANSION"))
      (second (third expanded)))))
