// Tennessee Saints brand palette
export const Colors = {
  saintsBlue: '#0b3a8d',
  saintsBlueDark: '#06255c',
  saintsGold: '#f5cf00',
  saintsGoldDark: '#d9af00',
  white: '#ffffff',
  light: '#f3f5f9',
  gray: '#dfe3ea',
  textPrimary: '#13233d',
  textSecondary: '#536277',
  textMuted: '#8a96a8',
  danger: '#d32f2f',
  success: '#2e7d32',
};

export default {
  light: {
    text: Colors.textPrimary,
    background: Colors.light,
    card: Colors.white,
    tint: Colors.saintsBlue,
    tabIconDefault: Colors.textMuted,
    tabIconSelected: Colors.saintsBlue,
    border: Colors.gray,
  },
  dark: {
    text: '#f0f0f0',
    background: '#0a0f1a',
    card: '#141c2e',
    tint: Colors.saintsGold,
    tabIconDefault: '#6b7a94',
    tabIconSelected: Colors.saintsGold,
    border: '#1e2a42',
  },
};
