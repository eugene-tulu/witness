import { DurableObject } from "cloudflare:workers";

// ─── Types ───────────────────────────────────────────────────────────────────

interface Env {
  ASSETS: Fetcher;
  INCIDENT: DurableObjectNamespace<IncidentObject>;
  INCIDENTS_KV: KVNamespace;
  AUDIO_BUCKET: R2Bucket;
  ELEVENLABS_API_KEY: string;
  ELEVENLABS_VOICE_ID: string;
}

interface Report {
  id: string;
  message: string;
  lat: number;
  lng: number;
  timestamp: number;
  confirmed: boolean;
}

interface IncidentState {
  id: string;
  type: string;
  location: string;
  lat: number;
  lng: number;
  reports: Report[];
  status: "active" | "resolved";
  createdAt: number;
  updatedAt: number;
  broadcastCount: number;
  narrative: string;
}

// ─── Incident Durable Object ──────────────────────────────────────────────────

export class IncidentObject extends DurableObject<Env> {
  private state: IncidentState | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  private async getState(): Promise<IncidentState | null> {
    if (this.state) return this.state;
    this.state = await this.ctx.storage.get<IncidentState>("incident") ?? null;
    return this.state;
  }

  private async saveState(state: IncidentState): Promise<void> {
    this.state = state;
    await this.ctx.storage.put("incident", state);
  }

  // Calculate distance between two points in meters using Haversine formula
  private haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371e3; // Earth's radius in meters
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lng2 - lng1) * Math.PI / 180;

    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
  }

  // Find active incidents within a radius (meters) of a point
  async findIncidentsWithinRadius(lat: number, lng: number, radiusMeters: number, maxResults: number = 5): Promise<{id: string, doId: string, distance: number, type: string}[]> {
    const list = await this.env.INCIDENTS_KV.list({ prefix: "incident:" });
    const nearby: {id: string, doId: string, distance: number, type: string}[] = [];

    for (const key of list.keys) {
      const val = await this.env.INCIDENTS_KV.get(key.name, "json");
      if (!val || val.status !== "active") continue;

      const distance = this.haversineDistance(lat, lng, val.lat, val.lng);
      if (distance <= radiusMeters) {
        nearby.push({ id: val.id, doId: val.doId, distance, type: val.type });
      }
    }

    nearby.sort((a, b) => a.distance - b.distance);
    return nearby.slice(0, maxResults);
  }

  // Internal method: creates/updates THIS incident without clustering logic
  private async addReportInternal(report: Omit<Report, "id" | "confirmed">, incidentMeta: { type: string; location: string }): Promise<IncidentState> {
    let state = await this.getState();

    const newReport: Report = {
      id: crypto.randomUUID(),
      ...report,
      confirmed: false,
    };

    if (!state) {
      // First report — create the incident
      state = {
        id: crypto.randomUUID(),
        type: incidentMeta.type,
        location: incidentMeta.location,
        lat: report.lat,
        lng: report.lng,
        reports: [newReport],
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        broadcastCount: 0,
        narrative: report.message,
      };

      await this.ctx.storage.setAlarm(Date.now() + 2 * 60 * 60 * 1000);
    } else {
      state.reports.push(newReport);
      state.updatedAt = Date.now();
      state.narrative = await this.buildNarrative(state);

      // Update location to weighted average
      const totalLat = state.reports.reduce((sum, r) => sum + r.lat, 0);
      const totalLng = state.reports.reduce((sum, r) => sum + r.lng, 0);
      state.lat = totalLat / state.reports.length;
      state.lng = totalLng / state.reports.length;
    }

    await this.saveState(state);

    if (state.reports.length >= 2 && state.broadcastCount === 0) {
      await this.broadcastAlert(state);
    }

    return state;
  }

  // Public entry point: handles clustering + routing to appropriate incident
  async addReport(report: Omit<Report, "id" | "confirmed">, incidentMeta: { type: string; location: string }): Promise<{state: IncidentState, grouped: boolean, matchedIncidentId?: string, matchedDistance?: number}> {
    // Search for nearby active incidents within 150m
    const radiusMeters = 150;
    const nearby = await this.findIncidentsWithinRadius(report.lat, report.lng, radiusMeters);
    const match = nearby.find(n => n.type === incidentMeta.type);

    if (match) {
      // Group with existing incident: directly update that incident's state
      const matchedDoId = this.env.INCIDENT.idFromString(match.doId);
      const matchedStub = this.env.INCIDENT.get(matchedDoId);
      // Add report to matched incident using its internal method (bypasses clustering check)
      const matchedState = await matchedStub.addReportInternal(report, incidentMeta);
      // Cache the updated incident
      await this.env.INCIDENTS_KV.put(
        `incident:${matchedState.id}`,
        JSON.stringify({ ...matchedState, doId: matchedDoId.toString() }),
        { expirationTtl: 60 * 60 * 3 }
      );
      return { state: matchedState, grouped: true, matchedIncidentId: match.id, matchedDistance: match.distance };
    } else {
      // No match → create new incident using THIS DO instance
      const state = await this.addReportInternal(report, incidentMeta);
      // Cache with this DO's id
      await this.env.INCIDENTS_KV.put(
        `incident:${state.id}`,
        JSON.stringify({ ...state, doId: this.ctx.id.toString() }),
        { expirationTtl: 60 * 60 * 3 }
      );
      return { state, grouped: false };
    }
  }

  async confirmReport(message: string): Promise<IncidentState> {
    const state = await this.getState();
    if (!state) throw new Error("Incident not found");

    state.reports.push({
      id: crypto.randomUUID(),
      message,
      lat: state.lat,
      lng: state.lng,
      timestamp: Date.now(),
      confirmed: true,
    });

    state.updatedAt = Date.now();
    state.narrative = await this.buildNarrative(state);
    await this.saveState(state);
    return state;
  }

  async resolve(): Promise<IncidentState> {
    const state = await this.getState();
    if (!state) throw new Error("Incident not found");

    state.status = "resolved";
    state.updatedAt = Date.now();
    await this.saveState(state);
    await this.broadcastResolution(state);
    return state;
  }

  async getIncident(): Promise<IncidentState | null> {
    return this.getState();
  }

  async alarm(): Promise<void> {
    const state = await this.getState();
    if (state && state.status === "active") {
      state.status = "resolved";
      await this.saveState(state);
      await this.broadcastResolution(state);
    }
  }

  private async buildNarrative(state: IncidentState): Promise<string> {
    const reportTexts = state.reports.map(r => r.message).join(". ");
    const count = state.reports.length;
    return `${count} report${count > 1 ? "s" : ""} near ${state.location}: ${reportTexts}`;
  }

  private async synthesizeVoice(text: string, incidentId: string): Promise<string | null> {
    try {
      const response = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${this.env.ELEVENLABS_VOICE_ID}`,
        {
          method: "POST",
          headers: {
            "xi-api-key": this.env.ELEVENLABS_API_KEY,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            text,
            model_id: "eleven_multilingual_v2",
            voice_settings: {
              stability: 0.5,
              similarity_boost: 0.75,
            },
          }),
        }
      );

      if (!response.ok) return null;

      const audioBuffer = await response.arrayBuffer();
      const key = `alerts/${incidentId}/${Date.now()}.mp3`;
      await this.env.AUDIO_BUCKET.put(key, audioBuffer, {
        httpMetadata: { contentType: "audio/mpeg" },
      });

      return key;
    } catch {
      return null;
    }
  }

  private async broadcastAlert(state: IncidentState): Promise<void> {
    const alertText =
      `Alert near ${state.location}. ` +
      `${state.type} reported ${state.reports.length} times. ` +
      `${state.narrative}. ` +
      `Stay safe and avoid the area if possible.`;

    const audioKey = await this.synthesizeVoice(alertText, state.id);

    state.broadcastCount += 1;
    if (audioKey) {
      (state as any).latestAudioKey = audioKey;
    }
    await this.saveState(state);
  }

  private async broadcastResolution(state: IncidentState): Promise<void> {
    const resolvedText =
      `Update for ${state.location}. ` +
      `The ${state.type} incident has been resolved. ` +
      `The area is now clear. Thank you for staying alert.`;

    await this.synthesizeVoice(resolvedText, state.id + "-resolved");
  }
}

// ─── Worker Router ────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    if (path === "/report" && request.method === "POST") {
      try {
        const body = await request.json() as {
          message: string;
          lat: number;
          lng: number;
          type: string;
          location: string;
          incidentId?: string;
        };

        if (body.incidentId) {
          // Explicit grouping: use that incident's DO
          const doId = env.INCIDENT.idFromString(body.incidentId);
          const stub = env.INCIDENT.get(doId);
          const state = await stub.addReportInternal(
            { message: body.message, lat: body.lat, lng: body.lng, timestamp: Date.now() },
            { type: body.type, location: body.location }
          );
          await env.INCIDENTS_KV.put(
            `incident:${state.id}`,
            JSON.stringify({ ...state, doId: doId.toString() }),
            { expirationTtl: 60 * 60 * 3 }
          );
          return new Response(JSON.stringify({ ...state, grouped: true, matchedIncidentId: body.incidentId }), {
            headers: { ...cors, "Content-Type": "application/json" },
          });
        } else {
          // New report: let the DO's addReport handle auto-clustering
          const doId = env.INCIDENT.newUniqueId();
          const stub = env.INCIDENT.get(doId);
          const result = await stub.addReport(
            { message: body.message, lat: body.lat, lng: body.lng, timestamp: Date.now() },
            { type: body.type, location: body.location }
          );
          return new Response(JSON.stringify({
            ...result.state,
            grouped: result.grouped,
            matchedIncidentId: result.matchedIncidentId,
            matchedDistance: result.matchedDistance
          }), {
            headers: { ...cors, "Content-Type": "application/json" },
          });
        }
      } catch (e) {
        return new Response(JSON.stringify({ error: "Failed to process report" }), {
          status: 500,
          headers: { ...cors, "Content-Type": "application/json" },
        });
      }
    }

    if (path === "/incidents" && request.method === "GET") {
      const list = await env.INCIDENTS_KV.list({ prefix: "incident:" });
      const incidents = await Promise.all(
        list.keys.map(async (key) => {
          const val = await env.INCIDENTS_KV.get(key.name, "json");
          return val;
        })
      );
      return new Response(JSON.stringify(incidents.filter(Boolean)), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    if (path.startsWith("/incident/") && request.method === "GET") {
      const id = path.split("/")[2];
      const cached = await env.INCIDENTS_KV.get(`incident:${id}`, "json") as any;
      if (!cached) {
        return new Response(JSON.stringify({ error: "Not found" }), {
          status: 404,
          headers: { ...cors, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(cached), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    if (path.startsWith("/confirm/") && request.method === "POST") {
      const id = path.split("/")[2];
      const cached = await env.INCIDENTS_KV.get(`incident:${id}`, "json") as any;
      if (!cached) {
        return new Response(JSON.stringify({ error: "Not found" }), {
          status: 404,
          headers: { ...cors, "Content-Type": "application/json" },
        });
      }

      const body = await request.json() as { message: string };
      const doId = env.INCIDENT.idFromString(cached.doId);
      const stub = env.INCIDENT.get(doId);
      const state = await stub.confirmReport(body.message);

      await env.INCIDENTS_KV.put(`incident:${id}`, JSON.stringify({ ...state, doId: cached.doId }), {
        expirationTtl: 60 * 60 * 3,
      });

      return new Response(JSON.stringify(state), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    if (path.startsWith("/resolve/") && request.method === "POST") {
      const id = path.split("/")[2];
      const cached = await env.INCIDENTS_KV.get(`incident:${id}`, "json") as any;
      if (!cached) {
        return new Response(JSON.stringify({ error: "Not found" }), {
          status: 404,
          headers: { ...cors, "Content-Type": "application/json" },
        });
      }

      const doId = env.INCIDENT.idFromString(cached.doId);
      const stub = env.INCIDENT.get(doId);
      const state = await stub.resolve();

      await env.INCIDENTS_KV.put(`incident:${id}`, JSON.stringify({ ...state, doId: cached.doId }), {
        expirationTtl: 60 * 60 * 3,
      });

      return new Response(JSON.stringify(state), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    if (path.startsWith("/audio/") && request.method === "GET") {
      const key = path.replace("/audio/", "");
      const obj = await env.AUDIO_BUCKET.get(key);
      if (!obj) {
        return new Response("Audio not found", { status: 404, headers: cors });
      }
      return new Response(obj.body, {
        headers: {
          ...cors,
          "Content-Type": "audio/mpeg",
          "Cache-Control": "public, max-age=3600",
        },
      });
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
