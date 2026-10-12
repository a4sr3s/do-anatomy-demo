/**
 * Hands the mounted anatomy's actions to React components that live outside
 * the SceneView tree (the sidebar sections). Set once by SceneView.
 */
export interface Actions {
  setSpeed(s: number): void;
  setAuto(on: boolean): void;
  setBloom(on: boolean): void;
  resetView(): void;
  replay(name: string, speed: number): Promise<void>;
  stopReplay(): Promise<void>;
  toggleRecord(): Promise<void>;
  refreshRecordings(): Promise<void>;
}

let current: Actions | null = null;

export const setActions = (a: Actions | null) => {
  current = a;
};
export const actions = () => current;
