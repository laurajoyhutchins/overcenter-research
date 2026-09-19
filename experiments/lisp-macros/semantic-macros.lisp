(defpackage :overcenter-semantic-macros
  (:use :cl)
  (:export :compile-declaration-string :defverifier))

(in-package :overcenter-semantic-macros)

(defun fail (code &optional detail)
  (error (if detail (format nil "~A:~A" code detail) code)))

(defun semantic-fields (specs role)
  (loop for (name type roles) in specs
        declare (ignore type)
        when (member role roles)
          collect name))

(defun normalize-field (spec)
  (destructuring-bind (name type &rest roles) spec
    (unless roles (fail "FIELD_WITHOUT_ROLE" (symbol-name name)))
    (dolist (role roles)
      (unless (member role '(coordinate desired output context))
        (fail "INVALID_FIELD_ROLE" (symbol-name role))))
    (unless (= (length roles) (length (remove-duplicates roles)))
      (fail "DUPLICATE_FIELD_ROLE" (symbol-name name)))
    (list name type roles)))

(defmacro defverifier
    (name fields-form observes-form absence-form effect-form
          settlement-form verify-form)
  (destructuring-bind (fields &rest raw-fields) fields-form
    (destructuring-bind (observes &rest raw-observes) observes-form
      (destructuring-bind (absence absence-kind) absence-form
        (destructuring-bind (settlement settlement-policy) settlement-form
          (destructuring-bind (verify op observed right) verify-form
            (unless (and (eq fields 'fields)
                         (eq observes 'observes)
                         (eq absence 'absence)
                         (eq settlement 'settlement)
                         (eq verify 'verify))
              (fail "INVALID_FORM_ORDER"))
            (let* ((specs (mapcar #'normalize-field raw-fields))
                   (names (mapcar #'first specs))
                   (coordinates (semantic-fields specs 'coordinate))
                   (desired (semantic-fields specs 'desired))
                   (outputs (semantic-fields specs 'output))
                   (observations
                     (mapcar
                       (lambda (spec)
                         (destructuring-bind (obs-name obs-type) spec
                           (declare (ignore obs-type))
                           obs-name))
                       raw-observes)))
              (unless (= (length names) (length (remove-duplicates names)))
                (fail "DUPLICATE_FIELD"))
              (when (null coordinates) (fail "NO_COORDINATE_FIELDS"))
              (unless (= (length desired) 1)
                (fail "EXPECTED_ONE_DESIRED_FIELD"))
              (unless (= (length outputs) 1)
                (fail "EXPECTED_ONE_OUTPUT_FIELD"))
              (unless (and (eq op 'eq) (eq right 'desired))
                (fail "INVALID_VERIFY"))
              (unless (member observed observations)
                (fail "UNKNOWN_VERIFY_OBSERVATION" (symbol-name observed)))
              (let ((absence-ir
                      (unless (eq absence-kind 'none)
                        (list :evidence-kind absence-kind
                              :subject-fields coordinates
                              :scope-fields coordinates)))
                    (effect-ir
                      (cond
                        ((equal effect-form '(effect none))
                         (list :kind 'none))
                        ((and (= (length effect-form) 4)
                              (eq (first effect-form) 'effect)
                              (eq (second effect-form) 'same-coordinate)
                              (eq (third effect-form) 'commutes)
                              (member (fourth effect-form) '(true false)))
                         (list :kind 'same-coordinate
                               :resource-fields coordinates
                               :desired-field (first desired)
                               :same-desired-commutes
                                 (eq (fourth effect-form) 'true)))
                        (t (fail "INVALID_EFFECT")))))
                (unless (member settlement-policy
                                '(present-only present-or-declared-absence))
                  (fail "INVALID_SETTLEMENT_POLICY"))
                (when (and absence-ir (eq settlement-policy 'present-only))
                  (fail "DECLARED_ABSENCE_UNUSED_BY_SETTLEMENT"))
                (when (and (null absence-ir)
                           (eq settlement-policy
                               'present-or-declared-absence))
                  (fail "SETTLEMENT_REQUIRES_DECLARED_ABSENCE"))
                (let ((ir
                        (list
                          :verifier name
                          :fields specs
                          :coordinate-fields coordinates
                          :output (list :selector 'verified-content
                                        :field (first outputs))
                          :absence absence-ir
                          :effect effect-ir
                          :settlement settlement-policy
                          :verification
                            (list :op 'eq
                                  :left-observation observed
                                  :right-field (first desired)))))
                  `(defparameter
                     ,(intern (format nil "*~A*" (symbol-name name))
                              *package*)
                     ',ir))))))))))

(defun read-one-declaration (source)
  (let ((*read-eval* nil)
        (*readtable* (copy-readtable nil))
        (*package* (find-package :overcenter-semantic-macros)))
    (with-input-from-string (stream source)
      (let ((form (read stream nil :eof))
            (extra nil))
        (when (eq form :eof) (fail "EMPTY_SOURCE"))
        (setf extra (read stream nil :eof))
        (unless (eq extra :eof) (fail "MULTIPLE_TOP_LEVEL_FORMS"))
        form))))

(defun compile-declaration-string (source)
  (let ((form (read-one-declaration source)))
    (unless (and (consp form) (eq (car form) 'defverifier))
      (fail "TOP_LEVEL_FORM_NOT_ALLOWED"))
    (let ((expanded (macroexpand-1 form)))
      (destructuring-bind (defparameter variable quoted-ir) expanded
        (declare (ignore variable))
        (unless (and (eq defparameter 'defparameter)
                     (consp quoted-ir)
                     (eq (first quoted-ir) 'quote))
          (fail "UNEXPECTED_MACRO_EXPANSION"))
        (second quoted-ir)))))
