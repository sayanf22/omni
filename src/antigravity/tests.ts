import { randomUUID } from 'crypto';
import { GravityField, ObjectState, SimulationConfig, SimulationConfigSchema } from './schemas.js';
import { 
  calculateTotalEnergy, 
  runSimulationStep, 
  SimulationState, 
  vecLength 
} from './physics.js';
import { 
  verifyExportBundle, 
  SecurityPrincipal 
} from './security.js';
import { startServer } from './server.js';

// Simple Test framework helper
let testsFailed = 0;
let testsPassed = 0;

const assert = (condition: boolean, message: string) => {
  if (!condition) {
    console.error(`  [FAIL] ${message}`);
    testsFailed++;
  } else {
    console.log(`  [PASS] ${message}`);
    testsPassed++;
  }
};

const runTestSuite = async () => {
  console.log('=== RUNNING PHYSICS ENGINE UNIT TESTS ===');
  
  // Setup standard orbital system config
  const objId = randomUUID();
  const fieldId = randomUUID();
  
  const initialObject: ObjectState = {
    id: objId,
    mass: 10,
    charge: 0,
    position: [10, 0, 0], // x = 10
    velocity: [0, 5, 0],  // orbiting velocity
    acceleration: [0, 0, 0],
  };

  const radialField: GravityField = {
    id: fieldId,
    type: 'radial',
    strength: 100, // attractive force field at origin
    center: [0, 0, 0],
    decayRate: 2, // 1/r^2 force decay
  };

  const config: SimulationConfig = {
    v_max: 100,
    a_max: 100,
    g_constant: 1.0,
    max_steps: 10000,
    fields: [radialField],
    initial_objects: [initialObject],
  };

  // 1. Physics Invariant: Conservation of Energy (Newtonian system)
  {
    const state: SimulationState = {
      sim_id: randomUUID(),
      project_id: randomUUID(),
      config_id: randomUUID(),
      seed: 42,
      timestep: 0.01,
      config,
      current_step: 0,
      objects: JSON.parse(JSON.stringify([initialObject])),
      status: 'active',
      initial_energy: 0,
      telemetry_logs: [],
      rng_state: 42,
    };
    
    state.initial_energy = calculateTotalEnergy(state.objects, config.fields, config.g_constant);
    state.telemetry_logs.push({
      step: 0,
      timestamp: new Date().toISOString(),
      total_energy: state.initial_energy,
      objects: JSON.parse(JSON.stringify(state.objects)),
      anomaly_detected: false,
    });

    // Run 100 steps
    let ok = true;
    for (let i = 0; i < 100; i++) {
      const stepResult = runSimulationStep(state, 0.01);
      if (!stepResult.success) {
        ok = false;
        break;
      }
    }
    
    assert(ok, 'Physics simulation stepped 100 times successfully.');
    
    const finalEnergy = calculateTotalEnergy(state.objects, config.fields, config.g_constant);
    const energyVariance = Math.abs(finalEnergy - state.initial_energy) / Math.abs(state.initial_energy);
    
    // Check that energy drift is conservative (less than 5% due to Euler integration approximation)
    assert(energyVariance < 0.05, `Energy conservation holds. Drift variance is ${(energyVariance * 100).toFixed(2)}%`);
  }

  // 2. Determinism and RNG reproducibility
  {
    const makeSim = (seed: number) => {
      const state: SimulationState = {
        sim_id: randomUUID(),
        project_id: randomUUID(),
        config_id: randomUUID(),
        seed,
        timestep: 0.01,
        config,
        current_step: 0,
        objects: JSON.parse(JSON.stringify([initialObject])),
        status: 'active',
        initial_energy: 0,
        telemetry_logs: [],
        rng_state: seed,
      };
      state.initial_energy = calculateTotalEnergy(state.objects, config.fields, config.g_constant);
      return state;
    };

    const sim1 = makeSim(12345);
    const sim2 = makeSim(12345);
    const sim3 = makeSim(99999); // different seed

    for (let i = 0; i < 50; i++) {
      runSimulationStep(sim1, 0.01);
      runSimulationStep(sim2, 0.01);
      runSimulationStep(sim3, 0.01);
    }

    const pos1 = sim1.objects[0].position;
    const pos2 = sim2.objects[0].position;
    const pos3 = sim3.objects[0].position;

    const match1and2 = pos1[0] === pos2[0] && pos1[1] === pos2[1] && pos1[2] === pos2[2];
    const match1and3 = pos1[0] === pos3[0] && pos1[1] === pos3[1] && pos1[2] === pos3[2];

    assert(match1and2, 'Simulations with identical seeds yield identical positions (reproducibility).');
    assert(!match1and3, 'Simulations with different seeds yield different positions (determinism).');
  }

  // 3. Clamping limits (v_max and a_max)
  {
    const fastObject: ObjectState = {
      id: randomUUID(),
      mass: 1,
      charge: 0,
      position: [0, 0, 0],
      velocity: [200, 0, 0], // initial velocity 200 (limit is 50)
      acceleration: [0, 0, 0],
    };
    
    const clampConfig: SimulationConfig = {
      v_max: 50, // Clamp velocity to 50
      a_max: 10, // Clamp acceleration to 10
      g_constant: 1.0,
      max_steps: 10,
      fields: [],
      initial_objects: [fastObject],
    };

    const state: SimulationState = {
      sim_id: randomUUID(),
      project_id: randomUUID(),
      config_id: randomUUID(),
      seed: 42,
      timestep: 0.1,
      config: clampConfig,
      current_step: 0,
      objects: [fastObject],
      status: 'active',
      initial_energy: 1000,
      telemetry_logs: [],
      rng_state: 42,
    };

    runSimulationStep(state, 0.1);
    const currentVelocity = vecLength(state.objects[0].velocity);
    assert(currentVelocity <= 50, `Velocity clamped to v_max. Current: ${currentVelocity} (v_max: 50)`);
  }

  // 4. Anomaly detection & auto-freeze
  {
    const unstableObject: ObjectState = {
      id: randomUUID(),
      mass: 1,
      charge: 0,
      position: [0.0001, 0, 0], // extremely close to radial center -> infinite force
      velocity: [0, 0, 0],
      acceleration: [0, 0, 0],
    };

    const unstableConfig: SimulationConfig = {
      v_max: 1000000,
      a_max: 1000000,
      g_constant: 1.0,
      max_steps: 1000,
      fields: [radialField],
      initial_objects: [unstableObject],
    };

    const state: SimulationState = {
      sim_id: randomUUID(),
      project_id: randomUUID(),
      config_id: randomUUID(),
      seed: 42,
      timestep: 0.01,
      config: unstableConfig,
      current_step: 0,
      objects: [unstableObject],
      status: 'active',
      initial_energy: -100,
      telemetry_logs: [],
      rng_state: 42,
    };

    const stepResult = runSimulationStep(state, 0.01);
    assert(stepResult.success === false && state.status === 'frozen', `Anomaly auto-freeze triggered successfully on physical blowup. Reason: ${state.anomaly_reason}`);
  }

  console.log('\n=== RUNNING SECURITY & INTEGRATION TESTS ===');
  
  // 5. Token Authentication & RBAC Checks
  const PORT = 8081;
  const server = startServer(PORT);
  
  const makeRequest = async (path: string, method: 'GET' | 'POST', body: any, principal: SecurityPrincipal | null) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (principal) {
      headers['Authorization'] = `Bearer ${JSON.stringify(principal)}`;
    }
    const response = await fetch(`http://localhost:${PORT}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    return {
      status: response.status,
      data: response.status !== 204 ? await response.json() : null,
    };
  };

  const operator: SecurityPrincipal = {
    userId: 'operator123',
    tenantId: 'tenantA',
    role: 'SimulationOperator',
  };

  const admin: SecurityPrincipal = {
    userId: 'admin123',
    tenantId: 'tenantA',
    role: 'TenantAdmin',
  };

  const viewer: SecurityPrincipal = {
    userId: 'viewer123',
    tenantId: 'tenantA',
    role: 'ReadOnlyViewer',
  };

  const validPayload = {
    project_id: randomUUID(),
    config_id: randomUUID(),
    config,
    seed: 123,
    timestep: 0.01,
  };

  try {
    // A. Unauthorized request
    const r1 = await makeRequest('/simulate/start', 'POST', validPayload, null);
    assert(r1.status === 401, 'Anonymous request rejected with 401.');

    // B. Forbidden role request
    const r2 = await makeRequest('/simulate/start', 'POST', validPayload, viewer);
    assert(r2.status === 403, 'Viewer request to start simulation rejected with 403.');

    // C. Valid operator request
    const r3 = await makeRequest('/simulate/start', 'POST', validPayload, operator);
    assert(r3.status === 201, 'Operator request to start simulation succeeds with 201.');
    const simId = r3.data.sim_id;

    // D. Step simulation
    const r4 = await makeRequest('/simulate/step', 'POST', { sim_id: simId, dt: 0.1 }, operator);
    assert(r4.status === 200, 'Stepping simulation returns 200.');

    // E. Quota validation (tenant quota = 5 max concurrent simulations)
    const activeSims: string[] = [simId];
    for (let i = 0; i < 4; i++) {
      const qRes = await makeRequest('/simulate/start', 'POST', validPayload, operator);
      if (qRes.status === 201) activeSims.push(qRes.data.sim_id);
    }
    assert(activeSims.length === 5, 'Tenant spun up exactly 5 concurrent simulations.');

    // Attempting 6th simulation
    const r5 = await makeRequest('/simulate/start', 'POST', validPayload, operator);
    assert(r5.status === 403, '6th simulation rejected with 403 (Quota exceeded).');

    // Clean up one simulation to free quota
    await makeRequest('/simulate/stop', 'POST', { sim_id: simId }, operator);
    const r6 = await makeRequest('/simulate/start', 'POST', validPayload, operator);
    assert(r6.status === 201, 'Succeeds to start new simulation after freeing quota.');
    activeSims.push(r6.data.sim_id);

    // F. Cryptographic Export & Verification
    // Non-admin exports log
    const r7 = await makeRequest(`/simulate/export?sim_id=${activeSims[1]}&format=json`, 'GET', null, operator);
    assert(r7.status === 403, 'Non-admin export rejected with 403.');

    // Admin exports log
    const r8 = await makeRequest(`/simulate/export?sim_id=${activeSims[1]}&format=json`, 'GET', null, admin);
    assert(r8.status === 200, 'Admin export returns 200.');
    const bundle = r8.data;
    assert(bundle.signature !== undefined, 'Export bundle includes cryptographic signature.');
    
    // Verify valid signature
    const validSig = verifyExportBundle(bundle);
    assert(validSig === true, 'Cryptographic signature verified successfully.');

    // Mutate bundle payload
    bundle.payload.seed = 999999;
    const tamperedSig = verifyExportBundle(bundle);
    assert(tamperedSig === false, 'Tampered export bundle signature rejected.');

  } catch (err) {
    console.error('Integration test failure:', err);
    testsFailed++;
  } finally {
    server.close();
  }

  console.log('\n=== RUNNING FUZZ TESTS ===');
  // 6. Fuzz testing of config parsing
  {
    const badConfigs = [
      { initial_objects: [] }, // empty objects list
      { initial_objects: [{ id: 'xyz', mass: -5, position: [0,0,0], velocity: [0,0,0] }] }, // negative mass
      { initial_objects: [{ id: 'xyz', mass: 10, position: [NaN,0,0], velocity: [0,0,0] }] }, // NaN coordinate
      { v_max: -10, initial_objects: [initialObject] }, // negative v_max
    ];

    let fuzzOk = true;
    for (const bad of badConfigs) {
      const parsed = SimulationConfigSchema.safeParse(bad);
      if (parsed.success) {
        fuzzOk = false;
        console.error('Fuzz failure: accepted malformed configuration: ', bad);
      }
    }
    assert(fuzzOk, 'Strict Zod schema validations rejected all malformed fuzz payloads.');
  }

  console.log('\n=== RUNNING LONG-RUN STABILITY TEST ===');
  // 7. Long-run stability (10,000 steps)
  {
    // A stable earth-sun like orbit model to run 10,000 steps without energy explosion or NaN
    const Sun: ObjectState = {
      id: randomUUID(),
      mass: 10000,
      charge: 0,
      position: [0, 0, 0],
      velocity: [0, 0, 0],
      acceleration: [0, 0, 0],
    };
    const Planet: ObjectState = {
      id: randomUUID(),
      mass: 0.1,
      charge: 0,
      position: [100, 0, 0],
      velocity: [0, 10, 0], // stable velocity vector
      acceleration: [0, 0, 0],
    };

    const orbitConfig: SimulationConfig = {
      v_max: 1000,
      a_max: 1000,
      g_constant: 1.0,
      max_steps: 10000,
      fields: [],
      initial_objects: [Sun, Planet],
    };

    const state: SimulationState = {
      sim_id: randomUUID(),
      project_id: randomUUID(),
      config_id: randomUUID(),
      seed: 777,
      timestep: 0.001, // small timestep for stability
      config: orbitConfig,
      current_step: 0,
      objects: [Sun, Planet],
      status: 'active',
      initial_energy: 0,
      telemetry_logs: [],
      rng_state: 777,
    };
    state.initial_energy = calculateTotalEnergy(state.objects, orbitConfig.fields, orbitConfig.g_constant);

    let stepCount = 0;
    let ok = true;
    for (let i = 0; i < 10000; i++) {
      const stepResult = runSimulationStep(state, 0.001);
      if (!stepResult.success) {
        ok = false;
        console.error(`Stability failed at step ${i} due to: ${state.anomaly_reason}`);
        break;
      }
      stepCount++;
    }

    assert(ok && stepCount === 10000, `Simulation ran 10,000 continuous ticks stably. Final step: ${stepCount}`);
  }

  console.log(`\n=== TEST RESULTS SUMMARY ===`);
  console.log(`PASSED: ${testsPassed}`);
  console.log(`FAILED: ${testsFailed}`);
  
  if (testsFailed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
};

runTestSuite();
