declare module 'claude-code' {
  interface PluginState {
    // Bumped when the prompt being read moves; the rail's sites read it while
    // drawing, so a bump draws them again, and them alone.
    'prompt-rail': { moved: number }
  }
}
