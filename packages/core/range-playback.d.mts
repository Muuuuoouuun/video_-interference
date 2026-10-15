export interface PlaybackMediaState { currentTime: number; readyState: number; paused?: boolean; ended?: boolean; seeking?: boolean; error?: boolean }
export interface PlaybackCommand { pause?: boolean; play?: boolean; seekFrame?: number }
export interface RangePlaybackConfiguration { versionId: string; durationFrames: number; frameIn: number; frameOut: number; loop: boolean; rangeAvailable?: boolean; locked?: boolean }
export interface RangePlaybackController {
  readonly playingRequested: boolean;
  readonly loopEnabled: boolean;
  configure(config: RangePlaybackConfiguration): PlaybackCommand | null;
  requestPlay(media: PlaybackMediaState): PlaybackCommand;
  requestPause(): PlaybackCommand;
  observePause(media: PlaybackMediaState): PlaybackCommand | null;
  observeFrame(media: PlaybackMediaState): PlaybackCommand | null;
  observeSeeked(): void;
  frameAt(seconds: number): number;
}
export function createRangePlaybackController(): RangePlaybackController;
