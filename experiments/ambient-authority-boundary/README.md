# Ambient authority boundary

## Question

If an agent already lives inside a sandbox whose ambient capabilities Overcenter does not control, which guarantees survive?

## Claim and contrast

For this bounded witness, Overcenter project truth remains authority-bound even when the surrounding worker substrate has an extra provider-write capability. The same result must also expose the negative: an inner sandbox cannot revoke a provider capability already held outside that sandbox.

The control is the same task packet with no ambient provider-write capability.

```text
controlled substrate                  foreign / over-capable substrate
same work packet                      same work packet
        |                                     |
        v                                     v
     worker                                worker
        |                                     |
 no provider tool                    ambient provider tool
        |                                     |
        +-------------+       +---------------+
                      |       |
                      v       v
                   external truth

          neither worker owns settlement authority
                         |
                         v
                  trusted verifier
                         |
                         v
                  Overcenter truth
```

## Run

```sh
npm run test:ambient-authority-boundary
```

## Falsification conditions

The claim is falsified if the over-capable worker can make Overcenter report DONE merely by returning a success assertion, or if possession of the modeled provider-write capability also grants it a path to settlement authority.

The physical-confinement negative is falsified if the over-capable arm cannot produce the provider effect despite being explicitly given the host capability.

## Interpretation

Passing both arms means the architectural boundary is narrower than "sandbox the agent": Overcenter can keep project truth outside an uncontrolled substrate, but it cannot claim to prevent external effects that the host independently authorizes.

This experiment intentionally models the host capability as an explicit object capability. It does not prove that a real hosted agent platform lacks hidden authority, nor does it replace the Rust confinement proof. A hosted follow-on should vary real job/tool permissions while holding the work packet fixed.
