export const AUDIO_MAX_BYTES: number;
export const AUDIO_EXTENSIONS: Readonly<Record<string,string>>;
export function audioPayload(value: unknown): {mime:string;base64:string;durationMs:number;bytes:number}|null;
