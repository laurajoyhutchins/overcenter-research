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

Deterministic capability-isolation witness:

```sh
npm run test:ambient-authority-boundary
```

Hosted permission-boundary witness:

```sh
gh workflow run ambient-authority-boundary.yml
```

The hosted workflow also runs when its pull request is moved out of draft. It keeps the work packet and source revision fixed across two worker jobs. The control gets `contents: read` only. The deliberately over-capable worker gets `contents: read` plus `statuses: write`. Neither receives `contents: write`, so neither owns Overcenter project authority.

## Falsification conditions

The project-truth claim is falsified if the over-capable worker can make Overcenter report DONE merely by returning success or by possessing the provider-write capability.

The physical-confinement negative is falsified if the over-capable arm cannot produce the provider effect despite being explicitly given the host capability.

The hosted proof additionally fails if the two workers do not observe the same packet digest, if the control can write the GitHub status, if the over-capable worker cannot write it, or if the over-capable worker's successful provider mutation advances the project to DONE before trusted recovery.

## Interpretation

Passing both arms means the architectural boundary is narrower than "sandbox the agent": Overcenter can keep project truth outside an uncontrolled substrate, but it cannot claim to prevent external effects that the host independently authorizes.

The deterministic case models the host tool as an explicit object capability. The hosted case turns that capability into a real GitHub job permission. Neither replaces the Rust confinement proof. Instead, they test the boundary outside Rust's jurisdiction: capabilities held by the parent agent environment.
