// The design's icon set: 24 viewBox line icons, stroke 1.8, round caps and joins.

function Svg({ size = 18, children }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      style={{ flexShrink: 0 }}>
      {children}
    </svg>
  );
}

export const ICONS = {
  copilot: () => <Svg><path d="M4 16V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-5 4v-4z" /></Svg>,
  insights: () => <Svg><path d="M3 8.5h18" /><path d="M15.5 5.5v6" /><path d="M3 16.5h18" /><path d="M8.5 13.5v6" /></Svg>,
  pipeline: () => <Svg><path d="M2.5 12h19" /><circle cx="6.5" cy="12" r="2" /><circle cx="13" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></Svg>,
  accounts: () => <Svg><rect x="5" y="4" width="14" height="16" rx="1.5" /><path d="M9 8.5h2M13 8.5h2M9 12.5h2M13 12.5h2M11 20v-3.5h2V20" /></Svg>,
  signals: () => <Svg><path d="M3 12h4l2.5-6.5 4 13L16 12h5" /></Svg>,
  outbound: () => <Svg><path d="M3.5 11.5 20.5 4.5 13.5 21.5 11.5 13.5z" /><path d="M11.5 13.5 20.5 4.5" /></Svg>,
  health: () => <Svg><path d="M5 19a8 8 0 1 1 14 0" /><path d="M12 14l3.5-3.5" /><circle cx="12" cy="14" r="1" /></Svg>,
  watchlist: () => <Svg><path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z" /><circle cx="12" cy="12" r="2.6" /></Svg>,
  studio: () => <Svg><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7.5 18.5 3 20l1.5-4.5z" /><path d="M14.5 5.5l3 3" /></Svg>,
};

export const ThumbUpIcon = () => <Svg size={15}><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" /></Svg>;
export const ThumbDownIcon = () => <Svg size={15}><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zM17 2h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17" /></Svg>;
export const LockIcon = () => <Svg size={16}><rect x="6" y="11" width="12" height="9" rx="2" /><path d="M9 11V8a3 3 0 0 1 6 0v3" /></Svg>;
export const ChevronLeft = () => <Svg size={16}><path d="M14 6l-6 6 6 6" /></Svg>;
export const ChevronRight = () => <Svg size={16}><path d="M10 6l6 6-6 6" /></Svg>;
export const CloseIcon = () => <Svg size={16}><path d="M6 6l12 12M18 6L6 18" /></Svg>;
