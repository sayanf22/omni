import * as http from 'http';
import * as url from 'url';
import { randomUUID } from 'crypto';
import { 
  SimulateStartRequestSchema, 
  SimulateStepRequestSchema, 
  SimulateStopRequestSchema,
  SimulateStatusRequestSchema,
  SimulateExportRequestSchema,
  SimulationConfig
} from './schemas.js';
import { 
  SimulationState, 
  calculateTotalEnergy, 
  runSimulationStep 
} from './physics.js';
import { 
  rateLimiter, 
  quotaManager, 
  checkPermission, 
  signExportBundle,
  SecurityPrincipal
} from './security.js';

// In-memory state store for active simulations
const simulations: Map<string, SimulationState> = new Map();

// Immutable in-memory audit logs
export interface AuditLogEntry {
  id: string;
  timestamp: string;
  userId: string;
  tenantId: string;
  action: string;
  simId?: string;
  outcome: 'success' | 'denied' | 'failed' | 'rate_limited' | 'quota_exceeded' | 'anomaly';
  details?: string;
}

export const auditLogs: AuditLogEntry[] = [];

const logAudit = (
  principal: SecurityPrincipal | null,
  action: string,
  simId: string | undefined,
  outcome: AuditLogEntry['outcome'],
  details?: string
) => {
  const entry: AuditLogEntry = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    userId: principal?.userId || 'anonymous',
    tenantId: principal?.tenantId || 'system',
    action,
    simId,
    outcome,
    details,
  };
  auditLogs.push(entry);
  console.log(`[AUDIT LOG] ${JSON.stringify(entry)}`);
};

// Authentication helper
const authenticate = (req: http.IncomingMessage): SecurityPrincipal | null => {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  try {
    const rawToken = authHeader.substring(7);
    // In production, this would verify a JWT.
    // For our secure backend demonstration, we parse the JSON configuration payload
    const principal = JSON.parse(rawToken) as SecurityPrincipal;
    if (!principal.userId || !principal.tenantId || !principal.role) {
      return null;
    }
    return principal;
  } catch (err) {
    return null;
  }
};

// Reads JSON body from the HTTP request stream
const readRequestBody = (req: http.IncomingMessage): Promise<string> => {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      resolve(body);
    });
    req.on('error', err => {
      reject(err);
    });
  });
};

// Send JSON responses helper
const sendJson = (res: http.ServerResponse, statusCode: number, data: any) => {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
};

export const startServer = (port = 8080): http.Server => {
  const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url || '', true);
    const method = req.method;

    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Authenticate
    const principal = authenticate(req);
    if (!principal) {
      logAudit(null, `access_${parsedUrl.pathname}`, undefined, 'denied', 'Missing or invalid Auth Token');
      return sendJson(res, 401, { error: 'Unauthorized. Invalid Bearer Token.' });
    }

    // Rate Limiting
    const rateLimitKey = `${principal.tenantId}:${principal.userId}`;
    if (rateLimiter.isRateLimited(rateLimitKey)) {
      logAudit(principal, `rate_limited_${parsedUrl.pathname}`, undefined, 'rate_limited');
      return sendJson(res, 429, { error: 'Too many requests. Rate limit exceeded.' });
    }

    try {
      if (parsedUrl.pathname === '/simulate/start' && method === 'POST') {
        // Auth check: Only Operators and Admins can start simulations
        if (!checkPermission(principal, ['SimulationOperator', 'TenantAdmin'])) {
          logAudit(principal, 'simulate_start', undefined, 'denied', 'Unauthorized role');
          return sendJson(res, 403, { error: 'Forbidden. Insufficient permissions.' });
        }

        const bodyText = await readRequestBody(req);
        const parseResult = SimulateStartRequestSchema.safeParse(JSON.parse(bodyText));

        if (!parseResult.success) {
          logAudit(principal, 'simulate_start', undefined, 'failed', 'Malformed request payload');
          return sendJson(res, 400, { error: 'Invalid config validation', details: parseResult.error.format() });
        }

        const payload = parseResult.data;
        const simId = randomUUID();

        // Enforce per-tenant concurrency limits
        if (!quotaManager.registerSimulation(principal.tenantId, simId)) {
          logAudit(principal, 'simulate_start', simId, 'quota_exceeded', 'Max concurrent simulations quota hit');
          return sendJson(res, 403, { error: 'Tenant quota exceeded. Maximum concurrent simulations reached.' });
        }

        // Initialize simulation physics state
        const config = payload.config as unknown as SimulationConfig;
        const initialEnergy = calculateTotalEnergy(
          config.initial_objects, 
          config.fields, 
          config.g_constant
        );

        const simState: SimulationState = {
          sim_id: simId,
          project_id: payload.project_id,
          config_id: payload.config_id,
          seed: payload.seed,
          timestep: payload.timestep,
          config,
          current_step: 0,
          objects: config.initial_objects,
          status: 'active',
          initial_energy: initialEnergy,
          telemetry_logs: [{
            step: 0,
            timestamp: new Date().toISOString(),
            total_energy: initialEnergy,
            objects: JSON.parse(JSON.stringify(config.initial_objects)),
            anomaly_detected: false,
          }],
          rng_state: payload.seed,
        };

        simulations.set(simId, simState);
        logAudit(principal, 'simulate_start', simId, 'success', `Simulation started with seed ${payload.seed}`);
        
        return sendJson(res, 201, { sim_id: simId, initial_energy: initialEnergy, status: 'active' });
      }

      if (parsedUrl.pathname === '/simulate/step' && method === 'POST') {
        // Auth check: Only Operators and Admins can step simulations
        if (!checkPermission(principal, ['SimulationOperator', 'TenantAdmin'])) {
          logAudit(principal, 'simulate_step', undefined, 'denied', 'Unauthorized role');
          return sendJson(res, 403, { error: 'Forbidden. Insufficient permissions.' });
        }

        const bodyText = await readRequestBody(req);
        const parseResult = SimulateStepRequestSchema.safeParse(JSON.parse(bodyText));

        if (!parseResult.success) {
          return sendJson(res, 400, { error: 'Invalid parameters', details: parseResult.error.format() });
        }

        const { sim_id, dt } = parseResult.data;
        const state = simulations.get(sim_id);

        if (!state) {
          return sendJson(res, 404, { error: 'Simulation not found' });
        }

        if (state.status !== 'active') {
          return sendJson(res, 400, { error: `Simulation is not active. Status: ${state.status}`, anomaly: state.anomaly_reason });
        }

        // Run fixed sub-steps
        const subSteps = Math.max(1, Math.round(dt / state.timestep));
        let anomalyDetected = false;
        let anomalyReason: string | undefined;

        for (let i = 0; i < subSteps; i++) {
          const stepResult = runSimulationStep(state, state.timestep);
          if (!stepResult.success) {
            anomalyDetected = true;
            anomalyReason = stepResult.anomaly;
            break;
          }
        }

        if (anomalyDetected) {
          quotaManager.deregisterSimulation(principal.tenantId, sim_id);
          logAudit(principal, 'simulate_step', sim_id, 'anomaly', `Simulation frozen: ${anomalyReason}`);
          return sendJson(res, 400, { 
            error: 'Simulation frozen due to numerical/energy anomaly',
            anomaly: anomalyReason,
            telemetry: {
              step: state.current_step,
              status: state.status,
              objects: state.objects
            }
          });
        }

        logAudit(principal, 'simulate_step', sim_id, 'success', `Simulated ${subSteps} sub-steps of delta ${state.timestep}`);
        return sendJson(res, 200, {
          sim_id,
          current_step: state.current_step,
          status: state.status,
          total_energy: state.telemetry_logs[state.telemetry_logs.length - 1].total_energy,
          objects: state.objects,
        });
      }

      if (parsedUrl.pathname === '/simulate/stop' && method === 'POST') {
        if (!checkPermission(principal, ['SimulationOperator', 'TenantAdmin'])) {
          logAudit(principal, 'simulate_stop', undefined, 'denied', 'Unauthorized role');
          return sendJson(res, 403, { error: 'Forbidden' });
        }

        const bodyText = await readRequestBody(req);
        const parseResult = SimulateStopRequestSchema.safeParse(JSON.parse(bodyText));

        if (!parseResult.success) {
          return sendJson(res, 400, { error: 'Invalid parameters' });
        }

        const { sim_id } = parseResult.data;
        const state = simulations.get(sim_id);

        if (!state) {
          return sendJson(res, 404, { error: 'Simulation not found' });
        }

        state.status = 'stopped';
        quotaManager.deregisterSimulation(principal.tenantId, sim_id);
        logAudit(principal, 'simulate_stop', sim_id, 'success', 'Simulation stopped manually');
        
        return sendJson(res, 200, { sim_id, status: 'stopped' });
      }

      if (parsedUrl.pathname === '/simulate/status' && method === 'GET') {
        // Query parameters parsing
        const querySimId = parsedUrl.query.sim_id;
        const parseResult = SimulateStatusRequestSchema.safeParse({ sim_id: querySimId });

        if (!parseResult.success) {
          return sendJson(res, 400, { error: 'Invalid parameter sim_id' });
        }

        const { sim_id } = parseResult.data;
        const state = simulations.get(sim_id);

        if (!state) {
          return sendJson(res, 404, { error: 'Simulation not found' });
        }

        return sendJson(res, 200, {
          sim_id: state.sim_id,
          project_id: state.project_id,
          config_id: state.config_id,
          status: state.status,
          current_step: state.current_step,
          initial_energy: state.initial_energy,
          current_energy: state.telemetry_logs[state.telemetry_logs.length - 1].total_energy,
          objects: state.objects,
          anomaly_reason: state.anomaly_reason,
        });
      }

      if (parsedUrl.pathname === '/simulate/export' && method === 'GET') {
        // Auth check: Export requires TenantAdmin role
        if (!checkPermission(principal, ['TenantAdmin'])) {
          logAudit(principal, 'simulate_export', undefined, 'denied', 'Unauthorized export request role');
          return sendJson(res, 403, { error: 'Forbidden. Admin role required for exporting logs.' });
        }

        const querySimId = parsedUrl.query.sim_id;
        const queryFormat = parsedUrl.query.format || 'json';
        const parseResult = SimulateExportRequestSchema.safeParse({ sim_id: querySimId, format: queryFormat });

        if (!parseResult.success) {
          return sendJson(res, 400, { error: 'Invalid export parameters' });
        }

        const { sim_id } = parseResult.data;
        const state = simulations.get(sim_id);

        if (!state) {
          return sendJson(res, 404, { error: 'Simulation not found' });
        }

        const finalEnergy = state.telemetry_logs[state.telemetry_logs.length - 1].total_energy;
        const bundle = signExportBundle(
          state.sim_id,
          state.project_id,
          state.config_id,
          state.seed,
          state.telemetry_logs,
          finalEnergy,
          state.status === 'frozen',
          state.anomaly_reason
        );

        logAudit(principal, 'simulate_export', sim_id, 'success', 'Simulation run successfully exported and cryptographically signed');
        return sendJson(res, 200, bundle);
      }

      // Route fallback
      sendJson(res, 404, { error: 'Endpoint not found' });

    } catch (error: any) {
      console.error(error);
      logAudit(principal, `internal_error_${parsedUrl.pathname}`, undefined, 'failed', error?.message);
      sendJson(res, 500, { error: 'Internal Server Error' });
    }
  });

  return server.listen(port);
};
