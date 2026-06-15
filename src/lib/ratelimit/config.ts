// Tunable rate-limit policy (Phase 7 spec §4). Keys namespace the shared rate_limits table.
export const RL = {
  loginPerIp:   { limit: 10,  windowSeconds: 900 },    // 10 / 15 min — brute-force
  registerPerIp:{ limit: 10,  windowSeconds: 900 },    // 10 / 15 min — spam tenants
  askPerMinute: { limit: 30,  windowSeconds: 60 },     // burst / runaway-loop guard
  askPerDay:    { limit: 500, windowSeconds: 86400 },  // daily cost ceiling
} as const;

export const rlKeys = {
  login:    (ip: string)  => `login:${ip}`,
  register: (ip: string)  => `register:${ip}`,
  askMin:   (rid: string) => `ask:min:${rid}`,
  askDay:   (rid: string) => `ask:day:${rid}`,
};
