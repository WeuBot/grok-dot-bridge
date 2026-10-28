declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    BRIDGE_INGRESS_ENABLED?: string;
    BRIDGE_INGRESS_SECRET?: string;
    BRIDGE_OWNER_ID?: string;
  }
}
