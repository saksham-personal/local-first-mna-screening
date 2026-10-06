/** Local ports. Override with environment variables so two checkouts can run side by side. */
const port = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 && value < 65536 ? value : fallback;
};

export const ports = {
  preview: port('SCREENING_UI_PORT', 4173),
  dev: port('SCREENING_DEV_PORT', 5173),
  bridge: port('SCREENING_BRIDGE_PORT', 7319),
  rust: port('SCREENING_RUST_PORT', 17318),
};

const loopback = ['127.0.0.1', 'localhost'];
export const allowedOrigins = new Set(loopback.flatMap(host => [ports.preview, ports.dev].map(value => `http://${host}:${value}`)));
export const allowedHosts = new Set(loopback.flatMap(host => [ports.bridge, ports.preview, ports.dev].map(value => `${host}:${value}`)));
