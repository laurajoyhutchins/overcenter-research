; Intentionally a tiny declarative language, not arbitrary executable Lisp.
; One semantic definition should replace several independently maintained
; TypeScript interpretations.

(defverifier artifact-content-at-revision/v1
  (fields
    (artifact string material)
    (source-revision digest material)
    (expected-sha256 digest material))

  (observes
    (observed-sha256 digest))

  (identity
    verifier-version
    artifact
    source-revision
    expected-sha256)

  (output verified-content expected-sha256)

  (absence artifact-enoent-at-revision/v1)

  (effect none)

  (settlement present-or-declared-absence)

  (verify eq observed-sha256 expected-sha256))
