; Tiny semantic declaration. Roles are declared once and projected mechanically.

(defverifier artifact-content-at-coordinate/v1
  (fields
    (artifact string coordinate)
    (source-revision digest coordinate)
    (expected-sha256 digest desired output))

  (observes
    (observed-sha256 digest))

  (absence artifact-enoent-at-coordinate/v1)
  (effect same-coordinate commutes true)
  (settlement present-or-declared-absence)
  (verify eq observed-sha256 desired))
