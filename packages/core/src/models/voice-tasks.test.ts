/**
 * Tareas de voz (sprint 8, agente L): la key de fal se comparte entre tareas
 * del mismo origen, y nunca hacia otro.
 */
import { describe, expect, it } from "vitest";
import type { ModelRegistrySnapshot, ModelTaskConfig } from "@fastgram/ports";

import {
  missingFields,
  resolveVoiceConfig,
  taskApiKey,
  toPublicTaskConfig,
} from "./config.js";
import { taskSpec } from "./presets.js";

const FAL = "https://queue.fal.run";
const fal = (over: Partial<ModelTaskConfig> = {}): ModelTaskConfig => ({
  provider: "fal",
  baseUrl: FAL,
  model: "fal-ai/wan/v2.2-a14b/text-to-video",
  ...over,
});

describe("tareas de voz", () => {
  it("son genai, están cableadas y sólo aceptan fal", () => {
    for (const task of ["speech", "avatar", "swap"] as const) {
      expect(taskSpec(task)).toMatchObject({ kind: "genai", wired: true });
      expect(taskSpec(task).providers).toEqual(["fal"]);
    }
  });

  it("sin key propia usan la de video (mismo origen)", () => {
    const snapshot: ModelRegistrySnapshot = {
      tasks: {
        video: fal({ apiKey: "fal-video-key-123456" }),
        speech: fal({ model: "fal-ai/elevenlabs/tts/eleven-v3" }),
      },
    };
    const speech = snapshot.tasks.speech as ModelTaskConfig;
    expect(taskApiKey("speech", speech, snapshot, {})?.key).toBe("fal-video-key-123456");
    expect(missingFields("speech", speech, {}, snapshot)).toEqual([]);
    expect(resolveVoiceConfig("speech", snapshot, {})).toEqual({
      task: "speech",
      provider: "fal",
      baseUrl: FAL,
      model: "fal-ai/elevenlabs/tts/eleven-v3",
      apiKey: "fal-video-key-123456",
    });
    const view = toPublicTaskConfig("speech", snapshot, null, {});
    expect(view.status).toBe("ready");
    expect(view.apiKey.hasKey).toBe(true);
    // La key nunca sale entera.
    expect(JSON.stringify(view)).not.toContain("fal-video-key-123456");
  });

  it("la key propia gana a la prestada", () => {
    const snapshot: ModelRegistrySnapshot = {
      tasks: {
        video: fal({ apiKey: "fal-video-key-123456" }),
        avatar: fal({ model: "x", apiKey: "fal-avatar-key-654321" }),
      },
    };
    expect(resolveVoiceConfig("avatar", snapshot, {})?.apiKey).toBe(
      "fal-avatar-key-654321",
    );
  });

  it("no toma prestada una key de otro origen", () => {
    const snapshot: ModelRegistrySnapshot = {
      tasks: {
        video: fal({ baseUrl: "https://other.example", apiKey: "k-123456789012" }),
        swap: fal({ model: "fal-ai/wan/v2.2-14b/animate/replace" }),
      },
    };
    expect(resolveVoiceConfig("swap", snapshot, {})).toBeNull();
    expect(toPublicTaskConfig("swap", snapshot, null, {}).missing).toEqual(["apiKey"]);
  });

  it("sin entrada propia la tarea no está configurada (el modelo lo elige el usuario)", () => {
    const snapshot: ModelRegistrySnapshot = {
      tasks: { video: fal({ apiKey: "fal-video-key-123456" }) },
    };
    expect(resolveVoiceConfig("speech", snapshot, {})).toBeNull();
    expect(toPublicTaskConfig("speech", snapshot, null, {}).status).toBe("unset");
  });

  it("las tareas de imagen no toman prestado nada", () => {
    const snapshot: ModelRegistrySnapshot = {
      tasks: {
        video: fal({ apiKey: "fal-video-key-123456" }),
        image: fal({ model: "fal-ai/flux/schnell" }),
      },
    };
    expect(
      taskApiKey("image", snapshot.tasks.image as ModelTaskConfig, snapshot, {}),
    ).toBe(null);
  });
});
