import { GravityField, ObjectState, SimulationConfig } from './schemas.js';

// Seedable Linear Congruential Generator (LCG) for deterministic RNG
export class SeededRNG {
  private state: number;

  constructor(seed: number) {
    // Force seed to be unsigned 32-bit integer
    this.state = seed >>> 0;
  }

  // Returns float between 0 (inclusive) and 1 (exclusive)
  next(): number {
    // glibc parameters
    this.state = (1103515245 * this.state + 12345) & 0x7fffffff;
    return this.state / 0x80000000;
  }

  nextRange(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  getState(): number {
    return this.state;
  }
}

export interface TelemetryTick {
  step: number;
  timestamp: string;
  total_energy: number;
  objects: ObjectState[];
  anomaly_detected: boolean;
  anomaly_reason?: string;
}

export interface SimulationState {
  sim_id: string;
  project_id: string;
  config_id: string;
  seed: number;
  timestep: number;
  config: SimulationConfig;
  current_step: number;
  objects: ObjectState[];
  status: 'active' | 'frozen' | 'completed' | 'stopped';
  initial_energy: number;
  telemetry_logs: TelemetryTick[];
  anomaly_reason?: string;
  rng_state: number; // to track the RNG state for reproducibility
}

// Vector algebra helper functions
export const vecLength = (v: [number, number, number]): number => {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
};

export const vecNormalize = (v: [number, number, number]): [number, number, number] => {
  const len = vecLength(v);
  if (len === 0) return [0, 0, 0];
  return [v[0] / len, v[1] / len, v[2] / len];
};

export const vecScale = (v: [number, number, number], s: number): [number, number, number] => {
  return [v[0] * s, v[1] * s, v[2] * s];
};

export const vecAdd = (v1: [number, number, number], v2: [number, number, number]): [number, number, number] => {
  return [v1[0] + v2[0], v1[1] + v2[1], v1[2] + v2[2]];
};

export const vecSub = (v1: [number, number, number], v2: [number, number, number]): [number, number, number] => {
  return [v1[0] - v2[0], v1[1] - v2[1], v1[2] - v2[2]];
};

export const vecDot = (v1: [number, number, number], v2: [number, number, number]): number => {
  return v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2];
};

// Calculate total energy of the simulation system (Kinetic + Potential)
export const calculateTotalEnergy = (objects: ObjectState[], fields: GravityField[], gConstant: number): number => {
  let kineticEnergy = 0;
  let potentialEnergy = 0;
  const EPSILON = 1e-6;

  for (let i = 0; i < objects.length; i++) {
    const obj = objects[i];
    const vLen = vecLength(obj.velocity);
    kineticEnergy += 0.5 * obj.mass * vLen * vLen;

    // Potential energy due to fields
    for (const field of fields) {
      const center = field.center;
      const pos = obj.position;
      const diff = vecSub(center, pos);
      const r = vecLength(diff) + EPSILON;

      if (field.type === 'radial' || field.type === 'repulsive') {
        const sign = field.type === 'repulsive' ? 1 : -1;
        const decayPower = field.decayRate || 2;
        if (decayPower === 1) {
          // Logarithmic potential
          potentialEnergy += sign * gConstant * obj.mass * field.strength * Math.log(r);
        } else {
          // Power potential
          potentialEnergy += (sign * gConstant * obj.mass * field.strength) / ((decayPower - 1) * Math.pow(r, decayPower - 1));
        }
      } else if (field.type === 'uniform') {
        // Linear potential along the vector towards center
        const dir = vecNormalize(center);
        potentialEnergy += -gConstant * obj.mass * field.strength * vecDot(pos, dir);
      } else if (field.type === 'tensor') {
        // Vortex/shear field: simplified harmonic potential model
        potentialEnergy += 0.5 * obj.mass * field.strength * vecDot(diff, diff);
      }
    }

    // Mutual Newtonian gravity potential energy between objects (if multiple objects exist)
    for (let j = i + 1; j < objects.length; j++) {
      const otherObj = objects[j];
      const diff = vecSub(otherObj.position, obj.position);
      const dist = vecLength(diff) + EPSILON;
      potentialEnergy += -(gConstant * obj.mass * otherObj.mass) / dist;
    }
  }

  return kineticEnergy + potentialEnergy;
};

// Validate that coords don't contain NaN, Infinity or exceed physical boundaries
export const checkNumericalOverflow = (obj: ObjectState, limit = 1000000): { ok: boolean; reason?: string } => {
  const lists = [obj.position, obj.velocity, obj.acceleration];
  for (const list of lists) {
    for (const val of list) {
      if (Number.isNaN(val)) return { ok: false, reason: `NaN detected on object ${obj.id}` };
      if (!Number.isFinite(val)) return { ok: false, reason: `Infinity detected on object ${obj.id}` };
      if (Math.abs(val) > limit) return { ok: false, reason: `Value ${val} exceeds safe boundary limit (${limit})` };
    }
  }
  return { ok: true };
};

// Step the simulation deterministically by a fixed delta-time
export const runSimulationStep = (
  state: SimulationState,
  dt: number
): { success: boolean; state: SimulationState; anomaly?: string } => {
  if (state.status !== 'active') {
    return { success: false, state };
  }

  const { config } = state;
  const nextObjects = state.objects.map(obj => ({
    ...obj,
    position: [...obj.position] as [number, number, number],
    velocity: [...obj.velocity] as [number, number, number],
    acceleration: [0, 0, 0] as [number, number, number],
  }));

  const EPSILON = 1e-6;

  const rng = new SeededRNG(state.rng_state);

  // 1. Calculate Forces/Accelerations
  for (let i = 0; i < nextObjects.length; i++) {
    const obj = nextObjects[i];
    let totalForce: [number, number, number] = [0, 0, 0];

    // Add seed-based physical micro-perturbation force (thermal/gravitational noise)
    const noiseForce: [number, number, number] = [
      rng.nextRange(-1e-6, 1e-6) * obj.mass,
      rng.nextRange(-1e-6, 1e-6) * obj.mass,
      rng.nextRange(-1e-6, 1e-6) * obj.mass,
    ];
    totalForce = vecAdd(totalForce, noiseForce);

    // Forces from external gravity fields
    for (const field of config.fields) {
      const diff = vecSub(field.center, obj.position);
      const r = vecLength(diff);
      const rSoftened = r + EPSILON;

      if (field.type === 'radial') {
        const dir = vecNormalize(diff);
        const decayPower = field.decayRate || 2;
        const forceMagnitude = (config.g_constant * obj.mass * field.strength) / Math.pow(rSoftened, decayPower);
        totalForce = vecAdd(totalForce, vecScale(dir, forceMagnitude));
      } else if (field.type === 'repulsive') {
        const dir = vecNormalize(diff);
        const decayPower = field.decayRate || 2;
        // Repulsive pushes away (negative force magnitude in center direction)
        const forceMagnitude = -(config.g_constant * obj.mass * field.strength) / Math.pow(rSoftened, decayPower);
        totalForce = vecAdd(totalForce, vecScale(dir, forceMagnitude));
      } else if (field.type === 'uniform') {
        // Constant force direction along normal of center
        const dir = vecNormalize(field.center);
        const forceMagnitude = config.g_constant * obj.mass * field.strength;
        totalForce = vecAdd(totalForce, vecScale(dir, forceMagnitude));
      } else if (field.type === 'tensor') {
        // Shear/vortex force: orthogonal force relative to direction to center
        // force = strength * [-dy, dx, 0]
        const dirX = -diff[1];
        const dirY = diff[0];
        const forceVector: [number, number, number] = vecNormalize([dirX, dirY, 0]);
        const forceMagnitude = config.g_constant * obj.mass * field.strength / rSoftened;
        totalForce = vecAdd(totalForce, vecScale(forceVector, forceMagnitude));
      }
    }

    // Mutual Newtonian gravity forces between objects
    for (let j = 0; j < nextObjects.length; j++) {
      if (i === j) continue;
      const other = nextObjects[j];
      const diff = vecSub(other.position, obj.position);
      const r = vecLength(diff) + EPSILON;
      const dir = vecNormalize(diff);
      const forceMagnitude = (config.g_constant * obj.mass * other.mass) / (r * r);
      totalForce = vecAdd(totalForce, vecScale(dir, forceMagnitude));
    }

    // Acceleration = Force / Mass
    let acceleration = vecScale(totalForce, 1 / obj.mass);

    // Safety limit acceleration clamping
    const accLen = vecLength(acceleration);
    if (accLen > config.a_max) {
      acceleration = vecScale(vecNormalize(acceleration), config.a_max);
    }
    obj.acceleration = acceleration;
  }

  // 2. Integration: Update Velocity and Positions
  for (const obj of nextObjects) {
    // velocity = velocity + acc * dt
    let nextVelocity = vecAdd(obj.velocity, vecScale(obj.acceleration, dt));

    // Safety limit velocity clamping
    const velLen = vecLength(nextVelocity);
    if (velLen > config.v_max) {
      nextVelocity = vecScale(vecNormalize(nextVelocity), config.v_max);
    }
    obj.velocity = nextVelocity;

    // position = position + velocity * dt
    obj.position = vecAdd(obj.position, vecScale(obj.velocity, dt));

    // 3. Numerical checks for safety
    const numericalCheck = checkNumericalOverflow(obj);
    if (!numericalCheck.ok) {
      state.status = 'frozen';
      state.anomaly_reason = numericalCheck.reason;
      return { success: false, state, anomaly: numericalCheck.reason };
    }
  }

  // 4. Anomaly Detection based on Energy
  const nextEnergy = calculateTotalEnergy(nextObjects, config.fields, config.g_constant);
  
  // Enforce energy limits (prevent numerical blowup or infinite acceleration hacks)
  // Standard closed system simulation has constant total energy. 
  // We allow up to 50% energy drift to account for high-dynamic maneuvers, but runaway blowup triggers freeze.
  const initialEnergyAbs = Math.abs(state.initial_energy);
  const energyDriftThreshold = Math.max(initialEnergyAbs * 1.5, 1000.0); // Minimum buffer of 1000 units
  
  if (Math.abs(nextEnergy) > energyDriftThreshold) {
    const reason = `Energy drift limit exceeded: Current Energy ${nextEnergy.toFixed(2)} (Initial: ${state.initial_energy.toFixed(2)})`;
    state.status = 'frozen';
    state.anomaly_reason = reason;
    return { success: false, state, anomaly: reason };
  }

  // Update simulation state parameters
  state.current_step += 1;
  state.objects = nextObjects;
  state.rng_state = rng.getState();

  // Add step telemetry log
  state.telemetry_logs.push({
    step: state.current_step,
    timestamp: new Date().toISOString(),
    total_energy: nextEnergy,
    objects: JSON.parse(JSON.stringify(nextObjects)),
    anomaly_detected: false,
  });

  if (state.current_step >= config.max_steps) {
    state.status = 'completed';
  }

  return { success: true, state };
};
