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

  // Called when a new report comes in
  async addReport(report: Omit<Report, "id" | "confirmed">, incidentMeta: { type: string; location: string }): Promise<IncidentState> {
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

      // Set alarm to auto-expire incident after 2 hours
      await this.ctx.storage.setAlarm(Date.now() + 2 * 60 * 60 * 1000);
    } else {
      state.reports.push(newReport);
      state.updatedAt = Date.now();
      state.narrative = await this.buildNarrative(state);
    }

    await this.saveState(state);

    // Trigger voice broadcast after 2+ reports
    if (state.reports.length >= 2 && state.broadcastCount === 0) {
      await this.broadcastAlert(state);
    }

    return state;
  }

  // Confirm/add info to an incident
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

  // Mark incident as resolved
  async resolve(): Promise<IncidentState> {
    const state = await this.getState();
    if (!state) throw new Error("Incident not found");

    state.status = "resolved";
    state.updatedAt = Date.now();
    await this.saveState(state);

    // Broadcast resolution
    await this.broadcastResolution(state);
    return state;
  }

  async getIncident(): Promise<IncidentState | null> {
    return this.getState();
  }

  // Alarm fires when incident auto-expires
  async alarm(): Promise<void> {
    const state = await this.getState();
    if (state && state.status === "active") {
      state.status = "resolved";
      await this.saveState(state);
      await this.broadcastResolution(state);
    }
  }

  // Build a human-readable narrative from all reports
  private async buildNarrative(state: IncidentState): Promise<string> {
    const reportTexts = state.reports.map(r => r.message).join(". ");
    const count = state.reports.length;
    return `${count} report${count > 1 ? "s" : ""} near ${state.location}: ${reportTexts}`;
  }

  // Synthesize voice via ElevenLabs TTS and store in R2
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
      // Store the latest audio key on the state so the frontend can stream it
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

    // CORS headers for frontend
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    // POST /report — submit a new incident report
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

        // Use provided incidentId (to group reports) or create new
        const doId = body.incidentId
          ? env.INCIDENT.idFromString(body.incidentId)
          : env.INCIDENT.newUniqueId();

        const stub = env.INCIDENT.get(doId);
        const state = await stub.addReport(
          { message: body.message, lat: body.lat, lng: body.lng, timestamp: Date.now() },
          { type: body.type, location: body.location }
        );

        // Cache incident in KV for map listing
        await env.INCIDENTS_KV.put(
          `incident:${state.id}`,
          JSON.stringify({ ...state, doId: doId.toString() }),
          { expirationTtl: 60 * 60 * 3 } // 3 hours
        );

        return new Response(JSON.stringify(state), {
          headers: { ...cors, "Content-Type": "application/json" },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: "Failed to process report" }), {
          status: 500,
          headers: { ...cors, "Content-Type": "application/json" },
        });
      }
    }

    // GET /incidents — list all active incidents from KV
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

    // GET /incident/:id — get a specific incident
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

    // POST /confirm/:id — confirm or add info to an incident
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

    // POST /resolve/:id — mark incident resolved
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

    // GET /audio/:key — stream audio from R2
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

    // Delegate everything else to ASSETS (frontend)
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;