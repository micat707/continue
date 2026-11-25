import { createSlice, PayloadAction } from "@reduxjs/toolkit";

export interface GuiArtifact {
  id: string;
  title: string;
  kind: string;
  content: string;
  filePath: string;
  format?: string;
  url: string;
  sessionId?: string;
  createdAt: string;
}

interface ArtifactsState {
  items: GuiArtifact[];
  panelOpen: boolean;
  activeArtifactId: string | null;
}

const initialState: ArtifactsState = {
  items: [],
  panelOpen: false,
  activeArtifactId: null,
};

export const artifactsSlice = createSlice({
  name: "artifacts",
  initialState,
  reducers: {
    addArtifact(state, action: PayloadAction<GuiArtifact>) {
      const idx = state.items.findIndex((a) => a.id === action.payload.id);
      if (idx >= 0) state.items[idx] = action.payload;
      else state.items.push(action.payload);
    },
    /** Replace all artifacts (from disk store after reload / watcher change). */
    setArtifacts(state, action: PayloadAction<GuiArtifact[]>) {
      state.items = action.payload;
      if (
        state.activeArtifactId &&
        !action.payload.some((a) => a.id === state.activeArtifactId)
      ) {
        state.activeArtifactId = null;
      }
    },
    removeArtifact(state, action: PayloadAction<string>) {
      state.items = state.items.filter((a) => a.id !== action.payload);
      if (state.activeArtifactId === action.payload)
        state.activeArtifactId = null;
    },
    setPanelOpen(state, action: PayloadAction<boolean>) {
      state.panelOpen = action.payload;
    },
    togglePanel(state) {
      state.panelOpen = !state.panelOpen;
    },
    setActiveArtifact(state, action: PayloadAction<string | null>) {
      state.activeArtifactId = action.payload;
    },
    clearArtifacts(state) {
      state.items = [];
      state.activeArtifactId = null;
    },
  },
});

export const {
  addArtifact,
  setArtifacts,
  removeArtifact,
  setPanelOpen,
  togglePanel,
  setActiveArtifact,
  clearArtifacts,
} = artifactsSlice.actions;

export const selectArtifacts = (state: {
  artifacts: ArtifactsState;
}): ArtifactsState => state.artifacts;

export default artifactsSlice.reducer;
