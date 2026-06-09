import * as crypto from 'crypto';

// Types for authentication and RBAC
export type UserRole = 'SimulationOperator' | 'TenantAdmin' | 'ReadOnlyViewer';

export interface SecurityPrincipal {
  userId: string;
  tenantId: string;
  role: UserRole;
}

// Simple in-memory rate-limiter store
class RateLimiter {
  private requests: Map<string, number[]> = new Map();
  private readonly windowMs = 60 * 1000; // 1 minute window
  private readonly maxRequests = 100;    // max 100 requests per window

  isRateLimited(key: string): boolean {
    const now = Date.now();
    const timestamps = this.requests.get(key) || [];
    
    // Filter out timestamps outside the window
    const activeTimestamps = timestamps.filter(t => now - t < this.windowMs);
    
    if (activeTimestamps.length >= this.maxRequests) {
      return true;
    }
    
    activeTimestamps.push(now);
    this.requests.set(key, activeTimestamps);
    return false;
  }
}

// Global rate limiter instance
export const rateLimiter = new RateLimiter();

// Simple in-memory tenant quota manager
class TenantQuotaManager {
  private activeSimulations: Map<string, Set<string>> = new Map();
  private readonly maxConcurrentSims = 5; // limit to 5 concurrent simulations per tenant

  registerSimulation(tenantId: string, simId: string): boolean {
    const sims = this.activeSimulations.get(tenantId) || new Set();
    if (sims.size >= this.maxConcurrentSims) {
      return false; // Quota exceeded
    }
    sims.add(simId);
    this.activeSimulations.set(tenantId, sims);
    return true;
  }

  deregisterSimulation(tenantId: string, simId: string): void {
    const sims = this.activeSimulations.get(tenantId);
    if (sims) {
      sims.delete(simId);
      if (sims.size === 0) {
        this.activeSimulations.delete(tenantId);
      } else {
        this.activeSimulations.set(tenantId, sims);
      }
    }
  }

  getActiveCount(tenantId: string): number {
    return this.activeSimulations.get(tenantId)?.size || 0;
  }
}

export const quotaManager = new TenantQuotaManager();

// RBAC validation helper
export const checkPermission = (principal: SecurityPrincipal, allowedRoles: UserRole[]): boolean => {
  return allowedRoles.includes(principal.role);
};

// Cryptographic signing of exportable simulation artifacts using HMAC-SHA256
const SERVER_SECRET_KEY = process.env.ANTIGRAVITY_SERVER_KEY || 'default-secure-server-signing-key-2026';

export interface SignedExportBundle {
  payload: {
    sim_id: string;
    project_id: string;
    config_id: string;
    seed: number;
    telemetry_summary: {
      total_steps: number;
      final_energy: number;
      has_anomaly: boolean;
      anomaly_reason?: string;
    };
    logs: any[];
  };
  signature: string;
  signed_at: string;
}

export const signExportBundle = (
  simId: string,
  projectId: string,
  configId: string,
  seed: number,
  logs: any[],
  finalEnergy: number,
  hasAnomaly: boolean,
  anomalyReason?: string
): SignedExportBundle => {
  const payload = {
    sim_id: simId,
    project_id: projectId,
    config_id: configId,
    seed,
    telemetry_summary: {
      total_steps: logs.length,
      final_energy: finalEnergy,
      has_anomaly: hasAnomaly,
      anomaly_reason: anomalyReason,
    },
    logs,
  };

  const payloadString = JSON.stringify(payload);
  const signature = crypto
    .createHmac('sha256', SERVER_SECRET_KEY)
    .update(payloadString)
    .digest('hex');

  return {
    payload,
    signature,
    signed_at: new Date().toISOString(),
  };
};

// Verify signature authenticity
export const verifyExportBundle = (bundle: SignedExportBundle): boolean => {
  const payloadString = JSON.stringify(bundle.payload);
  const expectedSignature = crypto
    .createHmac('sha256', SERVER_SECRET_KEY)
    .update(payloadString)
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(bundle.signature, 'hex'),
    Buffer.from(expectedSignature, 'hex')
  );
};
