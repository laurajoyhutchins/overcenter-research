(load "experiments/lisp-macros/semantic-macros.lisp")

(defpackage :overcenter-lisp-macro-tests
  (:use :cl)
  (:import-from :overcenter-semantic-macros
    :compile-declaration-string
    :defverifier))

(in-package :overcenter-lisp-macro-tests)

(defvar *checks* 0)
(defvar *read-eval-fired* nil)

(defun check (condition message)
  (incf *checks*)
  (unless condition
    (error "CHECK_FAILED: ~A" message)))

(defun file-string (path)
  (with-open-file (stream path :direction :input)
    (let ((out (make-string-output-stream)))
      (loop for line = (read-line stream nil nil)
            while line
            do (write-line line out))
      (get-output-stream-string out))))

(defun replace-once (source old new)
  (let ((at (search old source)))
    (unless at
      (error "REPLACEMENT_ANCHOR_NOT_FOUND: ~A" old))
    (concatenate 'string
      (subseq source 0 at)
      new
      (subseq source (+ at (length old))))))

(defun names (symbols)
  (mapcar (lambda (symbol)
            (string-downcase (symbol-name symbol)))
          symbols))

(defun signals-error-p (thunk &optional expected-fragment)
  (handler-case
      (progn (funcall thunk) nil)
    (error (condition)
      (if expected-fragment
          (not (null
            (search expected-fragment
                    (princ-to-string condition)
                    :test #'char-equal)))
          t))))

(defparameter *base-source*
  (file-string "experiments/lisp-macros/verifier.lisp"))

(let* ((ir (compile-declaration-string *base-source*))
       (coordinates (names (getf ir :coordinate-fields)))
       (effect (getf ir :effect))
       (absence (getf ir :absence)))
  (check (equal coordinates '("artifact" "source-revision"))
         "base coordinate projection")
  (check (equal (names (getf effect :resource-fields)) coordinates)
         "effect resource derives from coordinate role")
  (check (equal (names (getf absence :subject-fields)) coordinates)
         "absence subject derives from coordinate role")
  (check (equal (names (getf absence :scope-fields)) coordinates)
         "absence scope derives from coordinate role")
  (check (string= (string-downcase
                    (symbol-name (getf (getf ir :output) :field)))
                  "expected-sha256")
         "output role derives verified-content field"))

(let* ((evolved
         (replace-once
           *base-source*
           "(artifact string :coordinate)"
           (format nil "(authority string :coordinate)~%    (artifact string :coordinate)")))
       (ir (compile-declaration-string evolved))
       (coordinates (names (getf ir :coordinate-fields)))
       (effect (getf ir :effect))
       (absence (getf ir :absence)))
  (check (equal coordinates
                '("authority" "artifact" "source-revision"))
         "new coordinate appears once in the canonical coordinate set")
  (check (equal (names (getf effect :resource-fields)) coordinates)
         "new coordinate automatically reaches effect identity")
  (check (equal (names (getf absence :subject-fields)) coordinates)
         "new coordinate automatically reaches absence subject")
  (check (equal (names (getf absence :scope-fields)) coordinates)
         "new coordinate automatically reaches absence scope"))

(let* ((with-context
         (replace-once
           *base-source*
           "(artifact string :coordinate)"
           (format nil "(display-label string :context)~%    (artifact string :coordinate)")))
       (base (compile-declaration-string *base-source*))
       (evolved (compile-declaration-string with-context)))
  (check (equal (getf base :coordinate-fields)
                (getf evolved :coordinate-fields))
         "context field does not contaminate coordinate identity")
  (check (equal (getf base :output)
                (getf evolved :output))
         "context field does not contaminate output identity"))

(check
  (signals-error-p
    (lambda ()
      (compile-declaration-string
        (replace-once *base-source*
                      " digest :desired :output"
                      " digest :output")))
    "EXPECTED_ONE_DESIRED_FIELD")
  "missing desired role rejected during macro expansion")

(check
  (signals-error-p
    (lambda ()
      (compile-declaration-string
        (replace-once *base-source*
                      " digest :desired :output"
                      " digest :desired")))
    "EXPECTED_ONE_OUTPUT_FIELD")
  "missing output role rejected during macro expansion")

(check
  (signals-error-p
    (lambda ()
      (compile-declaration-string
        (replace-once *base-source*
          (format nil "  (:settlement :present-or-declared-absence)~%")
          "")))
    nil)
  "missing settlement semantics rejected by macro shape")

(check
  (signals-error-p
    (lambda ()
      (compile-declaration-string
        (replace-once *base-source*
          "(:settlement :present-or-declared-absence)"
          "(:settlement :present-only)")))
    "DECLARED_ABSENCE_UNUSED_BY_SETTLEMENT")
  "absence and settlement disagreement rejected")

(check
  (signals-error-p
    (lambda ()
      (compile-declaration-string
        "(progn (error \"should-never-run\"))"))
    "TOP_LEVEL_FORM_NOT_ALLOWED")
  "arbitrary top-level Lisp is data, not executable authority")

(setf *read-eval-fired* nil)
(check
  (signals-error-p
    (lambda ()
      (compile-declaration-string
        "#.(progn (setf overcenter-lisp-macro-tests::*read-eval-fired* t) '(defverifier x))")))
  "reader evaluation syntax is rejected")
(check (null *read-eval-fired*)
       "*READ-EVAL* NIL prevented read-time execution")

(let ((a (compile-declaration-string *base-source*))
      (b (compile-declaration-string *base-source*)))
  (check (equal a b)
         "macro expansion produces deterministic semantic IR"))

;; Macro-specific extension experiment: a trusted higher-level macro can add
;; authoring vocabulary by expanding into the validated core form. The core
;; semantic compiler is not modified and retains final authority over roles.
(defmacro defcontent-verifier (name absence-kind)
  `(defverifier ,name
     (:fields
       (artifact string :coordinate)
       (source-revision digest :coordinate)
       (expected-sha256 digest :desired :output))
     (:observes
       (observed-sha256 digest))
     (:absence ,absence-kind)
     (:effect :same-coordinate :commutes t)
     (:settlement :present-or-declared-absence)
     (:verify eq observed-sha256 :desired)))

(let* ((surface
         '(defcontent-verifier compact-content/v1
            artifact-enoent-at-coordinate/v1))
       (core (macroexpand-1 surface))
       (final (macroexpand-1 core)))
  (check (eq (first core) 'defverifier)
         "trusted surface macro expands into the validated semantic core")
  (check (eq (first final) 'defparameter)
         "core macro then emits inert semantic IR"))

(format t "Common Lisp semantic macro experiment: ~D checks passed.~%"
        *checks*)
