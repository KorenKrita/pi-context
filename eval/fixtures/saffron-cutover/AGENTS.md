# Saffron Delivery Rules

- Keep changes minimal and explain the source that controls each release claim.
- A vendor observation is not permission to bypass Control Policy.
- Never start a rollout while a release freeze is active.
- Every release decision must name the control-plane revision it was based on.
- Every release decision must preserve the current control-plane incident nonce and linkage.
- Preserve the order: plan, policy acknowledgement, then rollout.
- Run the project checks before declaring delivery complete.
