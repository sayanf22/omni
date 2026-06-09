# Anti-Gravity Subsystem Backend — Specification

## 1. Zod & JSON Schemas

### GravityField Schema
Validates the physical properties of gravity fields (attractive, repulsive, uniform, or tensor shear fields).
```json
{
  "type": "object",
  "properties": {
    "id": { "type": "string", "format": "uuid" },
    "type": { "type": "string", "enum": ["uniform", "radial", "tensor", "repulsive"] },
    "strength": { "type": "number" },
    "center": {
      "type": "array",
      "items": { "type": "number" },
      "minItems": 3,
      "maxItems": 3
    },
    "decayRate": { "type": "number", "minimum": 0 }
  },
  "required": ["id", "type", "strength", "center"]
}
```

### ObjectState Schema
Validates individual physical objects tracked in the anti-gravity vector space.
```json
{
  "type": "object",
  "properties": {
    "id": { "type": "string", "format": "uuid" },
    "mass": { "type": "number", "exclusiveMinimum": 0 },
    "charge": { "type": "number" },
    "position": {
      "type": "array",
      "items": { "type": "number" },
      "minItems": 3,
      "maxItems": 3
    },
    "velocity": {
      "type": "array",
      "items": { "type": "number" },
      "minItems": 3,
      "maxItems": 3
    },
    "acceleration": {
      "type": "array",
      "items": { "type": "number" },
      "minItems": 3,
      "maxItems": 3
    }
  },
  "required": ["id", "mass", "position", "velocity"]
}
```

### SimulationConfig Schema
Validates global simulation limits, invariants, and initial conditions.
```json
{
  "type": "object",
  "properties": {
    "v_max": { "type": "number", "minimum": 0 },
    "a_max": { "type": "number", "minimum": 0 },
    "g_constant": { "type": "number" },
    "max_steps": { "type": "integer", "minimum": 1 },
    "fields": {
      "type": "array",
      "items": { "$ref": "#/definitions/GravityField" }
    },
    "initial_objects": {
      "type": "array",
      "items": { "$ref": "#/definitions/ObjectState" },
      "minItems": 1
    }
  },
  "required": ["initial_objects"]
}
```

---

## 2. API Specification

| Endpoint | Method | Request Payload | Response (Success) | Description |
|---|---|---|---|---|
| `/simulate/start` | POST | `{ project_id, config_id, config, seed, timestep }` | `{ sim_id, initial_energy, status: "active" }` | Registers user seed and starts simulation. |
| `/simulate/step` | POST | `{ sim_id, dt }` | `{ sim_id, current_step, status, total_energy, objects }` | Evaluates the physics step over a duration `dt`. |
| `/simulate/stop` | POST | `{ sim_id }` | `{ sim_id, status: "stopped" }` | Halts simulation and frees resources. |
| `/simulate/status` | GET | `?sim_id=<uuid>` | `{ sim_id, status, current_step, initial_energy, current_energy, objects }` | Returns current state and telemetry metrics. |
| `/simulate/export` | GET | `?sim_id=<uuid>&format=json` | `{ payload: { ... }, signature, signed_at }` | Returns a signed telemetry bundle for audit. Requires `TenantAdmin`. |

---

## 3. Security Checklist

### Authentication & Tenant Isolation
* [x] **Bearer Tokens:** Handled via JSON-payload authorization in transit (mocked OAuth principal claims).
* [x] **Tenant Boundaries:** All simulation sessions (`simulations` memory map) are associated with a `tenantId`.
* [x] **Deny-by-Default:** Reject requests lacking valid authentication tokens or permission claims.

### Role-Based Access Control (RBAC)
* [x] **SimulationOperator:** Authorized to start, step, and stop simulations.
* [x] **TenantAdmin:** Authorized to execute simulation control, view status, and download/export signed runs.
* [x] **ReadOnlyViewer:** Authorized strictly to request `status` telemetry queries.

### Resource Controls & Sandboxing
* [x] **Rate Limiting:** Sliding-window rate limit enforces a maximum of 100 requests per minute per authenticated principal.
* [x] **Concurrency Quotas:** Restricts each tenant to a maximum of 5 concurrent active simulation sessions.
* [x] **Execution Bounds:** Clamped execution slice duration (`sub_dt`) to prevent long-running thread blocks.

### Cryptographic Protections
* [x] **Signature Verification:** Exported run records are signed with HMAC-SHA256 using a server-managed secret key (`ANTIGRAVITY_SERVER_KEY`).
* [x] **Integrity Auditing:** Tamper detection uses `timingSafeEqual` to verify bundle signatures.
* [x] **Sensitive Sanitization:** API secrets, signing keys, and raw authentication tokens are never written to standard stdout logs or database tables.

---

## 4. Test Matrix

### Unit Tests
* **Invariant Conservation:** Check energy drift remains within bounds ($< 1\%$) in a simple closed system.
* **Deterministic Execution:** Validate that identical seeds recreate object positions with $100\%$ precision (0 variance).
* **Speed/Acc Clamping:** Verify velocity is clamped to `v_max` and acceleration is clamped to `a_max`.

### Integration Tests
* **Authentication Guards:** Reject requests without headers or with invalid roles.
* **Quota Enforcement:** Attempt to spin up more than 5 parallel simulations under a single tenant.
* **Tamper Proofing:** Mutate telemetry objects inside an exported bundle and verify signature failure.

### Fuzz Tests
* **Corrupt JSON Payloads:** Send incomplete or randomly typed inputs (negative timestep, extremely large integers).
* **Physics Breakage:** Set object mass to $0$ or negative values, or place objects exactly at center of radial field ($r = 0$).

### Long-Run Stability
* **Divergence Guard:** Simulate 10,000 continuous steps to confirm no floating-point overflows occur.
* **Checkpoints:** Trigger auto-freeze when artificial energy spike occurs, saving state.
