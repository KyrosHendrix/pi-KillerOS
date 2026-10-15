// Node's Windows shutdown fix landed in 24.20.0: nodejs/node#61999.
// The RPC pilot reproduces the assertion on 24.19.0, not on 22.19.0 or 24.20.0.
export const piRpcShutdownSkip = process.platform === "win32" && process.versions.node === "24.19.0"
  ? "Windows Node 24.19.0 has a native RPC shutdown crash; use Node 22.19.0 or 24.20.0+"
  : false;
