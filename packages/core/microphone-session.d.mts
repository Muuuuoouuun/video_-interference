export function acquireMicrophone(getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>, signal: AbortSignal): Promise<MediaStream | null>;
export function stopMicrophone(stream: MediaStream | null | undefined): void;
