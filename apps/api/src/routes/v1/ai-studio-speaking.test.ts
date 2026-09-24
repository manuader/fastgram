/**
 * Sprint 8 (agente L): paridad contrato ↔ core de lo que los dos repiten (el
 * contrato es standalone y no importa `core`).
 */
import {
  SPEAKING_CAPTION_MAX_CHARS as CONTRACT_CAPTION_MAX,
  SPEAKING_TOPIC_MAX_CHARS as CONTRACT_TOPIC_MAX,
  modelTaskSchema,
  speakingRunErrorCodeSchema,
  speakingRunStageSchema,
} from "@fastgram/contracts";
import {
  SPEAKING_CAPTION_MAX_CHARS,
  SPEAKING_RUN_ERROR_CODES,
  SPEAKING_RUN_STAGES,
  SPEAKING_TOPIC_MAX_CHARS,
  VOICE_TASKS,
} from "@fastgram/core";
import { describe, expect, it } from "vitest";

describe("paridad contrato ↔ core (sprint 8, formatos con voz)", () => {
  it("topes, etapas, códigos y tareas coinciden", () => {
    expect(CONTRACT_CAPTION_MAX).toBe(SPEAKING_CAPTION_MAX_CHARS);
    expect(CONTRACT_TOPIC_MAX).toBe(SPEAKING_TOPIC_MAX_CHARS);
    expect(speakingRunStageSchema.options).toEqual([...SPEAKING_RUN_STAGES]);
    for (const code of SPEAKING_RUN_ERROR_CODES) {
      expect(speakingRunErrorCodeSchema.options).toContain(code);
    }
    for (const task of VOICE_TASKS) {
      expect(modelTaskSchema.options).toContain(task);
    }
  });
});
