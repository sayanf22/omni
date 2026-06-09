import { z } from 'zod';

// Zod Schema for anti-gravity field configurations
export const GravityFieldSchema = z.object({
  id: z.string().uuid(),
  type: z.enum(['uniform', 'radial', 'tensor', 'repulsive']),
  strength: z.number().finite(),
  center: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]), // [x, y, z]
  decayRate: z.number().nonnegative().finite().default(0), // 0 means no decay with distance
});

// Zod Schema for individual objects in the simulation
export const ObjectStateSchema = z.object({
  id: z.string().uuid(),
  mass: z.number().positive().finite(), // Mass must be strictly positive
  charge: z.number().finite().default(0),
  position: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]), // [x, y, z]
  velocity: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]), // [vx, vy, vz]
  acceleration: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]).default([0, 0, 0]), // [ax, ay, az]
});

// Zod Schema for global simulation configuration
export const SimulationConfigSchema = z.object({
  v_max: z.number().positive().finite().default(1000.0), // Clamp velocities
  a_max: z.number().positive().finite().default(500.0),  // Clamp accelerations
  g_constant: z.number().finite().default(1.0),
  max_steps: z.number().int().positive().default(20000),
  fields: z.array(GravityFieldSchema).default([]),
  initial_objects: z.array(ObjectStateSchema).min(1),
});

// API Request schemas
export const SimulateStartRequestSchema = z.object({
  project_id: z.string().uuid(),
  config_id: z.string().uuid(),
  config: SimulationConfigSchema,
  seed: z.number().int().finite(),
  timestep: z.number().positive().finite().default(0.01),
});

export const SimulateStepRequestSchema = z.object({
  sim_id: z.string().uuid(),
  dt: z.number().positive().finite(),
});

export const SimulateStopRequestSchema = z.object({
  sim_id: z.string().uuid(),
});

export const SimulateStatusRequestSchema = z.object({
  sim_id: z.string().uuid(),
});

export const SimulateExportRequestSchema = z.object({
  sim_id: z.string().uuid(),
  format: z.enum(['json', 'csv']).default('json'),
});

// Explicit strict types
export interface GravityField {
  id: string;
  type: 'uniform' | 'radial' | 'tensor' | 'repulsive';
  strength: number;
  center: [number, number, number];
  decayRate: number;
}

export interface ObjectState {
  id: string;
  mass: number;
  charge: number;
  position: [number, number, number];
  velocity: [number, number, number];
  acceleration: [number, number, number];
}

export interface SimulationConfig {
  v_max: number;
  a_max: number;
  g_constant: number;
  max_steps: number;
  fields: GravityField[];
  initial_objects: ObjectState[];
}

export type SimulateStartRequest = z.infer<typeof SimulateStartRequestSchema>;
export type SimulateStepRequest = z.infer<typeof SimulateStepRequestSchema>;
export type SimulateStopRequest = z.infer<typeof SimulateStopRequestSchema>;
export type SimulateStatusRequest = z.infer<typeof SimulateStatusRequestSchema>;
export type SimulateExportRequest = z.infer<typeof SimulateExportRequestSchema>;

