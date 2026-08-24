import type { ComponentType, SVGProps } from "react";

/**
 * The EthixWeb icon set.
 *
 * Drawn for this product rather than pulled from a library, so the sidebar
 * carries the brand instead of looking like every other dashboard. The shapes
 * come from two things that are already ours:
 *
 *   1. The emblem, which is built from rounded bars hung off a spine. Every
 *      glyph here is assembled the same way -- bars and slots, not outlines.
 *   2. The spiderweb on the marketing site, whose junctions read as nodes.
 *      Every glyph carries at least one filled node, and that dot is the tell
 *      that ties the set together.
 *
 * Rules, so a new icon drops in without redrawing the others:
 *   - 24x24 grid, artwork inside 3..21 so every glyph has the same optical mass
 *   - strokeWidth 1.9 by default, round caps and joins, never a hairline
 *   - bars are rounded rects, rx 1.4-1.8
 *   - nodes are filled circles, r 1.15, no stroke
 *   - one accent node per glyph, placed where the eye lands last
 */

export type EthixIconProps = SVGProps<SVGSVGElement>;
export type EthixIcon = ComponentType<EthixIconProps>;

function Icon({ children, strokeWidth = 1.9, ...props }: EthixIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {children}
    </svg>
  );
}

/** The accent junction. Filled, never stroked, so it holds at 16px. */
function Node({ cx, cy, r = 1.15 }: { cx: number; cy: number; r?: number }) {
  return <circle cx={cx} cy={cy} r={r} fill="currentColor" stroke="none" />;
}

/* -- Workspace ---------------------------------------------------------- */

/**
 * The emblem itself: a full-height spine with three bars laid across it,
 * which together read as the E.
 *
 * Traced off the mark rather than approximated -- the bars run *over* the
 * spine instead of sitting beside it, so the seam shows through exactly where
 * it does on the logo, and each plane carries the frosted fill that keeps the
 * whole thing legible as one solid shape at tab size instead of dissolving
 * into four thin outlines.
 */
export const IconDashboard: EthixIcon = (p) => (
  <Icon strokeWidth={1.5} {...p}>
    <rect x="3.6" y="3.8" width="3.6" height="16.4" rx="1.1" fill="currentColor" fillOpacity="0.13" />
    <rect x="6.6" y="3.8" width="13.8" height="4.2" rx="1.2" fill="currentColor" fillOpacity="0.13" />
    <rect x="6.6" y="9.9" width="13.8" height="4.2" rx="1.2" fill="currentColor" fillOpacity="0.13" />
    <rect x="6.6" y="16" width="13.8" height="4.2" rx="1.2" fill="currentColor" fillOpacity="0.13" />
  </Icon>
);

/** A slot with a raised tab -- a tray of work, not a paper folder. */
export const IconProjects: EthixIcon = (p) => (
  <Icon {...p}>
    <path d="M3.2 8.4V6.6a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.6.8l1.1 1.5" />
    <rect x="3.2" y="8.4" width="17.6" height="11.2" rx="2.4" />
    <Node cx={16.6} cy={14} />
  </Icon>
);

/** Bars with every junction struck solid -- three nodes, equal weight. */
export const IconTasks: EthixIcon = (p) => (
  <Icon {...p}>
    <path d="M10 6.6h10.8M10 12h10.8M10 17.4h6.6" />
    <Node cx={4.8} cy={6.6} r={1.7} />
    <Node cx={4.8} cy={12} r={1.7} />
    <Node cx={4.8} cy={17.4} r={1.7} />
  </Icon>
);

/** The web, read as a globe: radials off a centre, junctions marked. */
export const IconDomains: EthixIcon = (p) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.6" />
    <path d="M12 3.4v17.2M3.4 12h17.2" />
    <path d="M12 3.4c2.6 2.3 4 5.3 4 8.6s-1.4 6.3-4 8.6c-2.6-2.3-4-5.3-4-8.6s1.4-6.3 4-8.6Z" />
    <Node cx={12} cy={12} />
  </Icon>
);

/* -- Operations & Finance ----------------------------------------------- */

/** A climb plotted across the web, each reading a node. */
export const IconProgress: EthixIcon = (p) => (
  <Icon {...p}>
    <path d="M3.6 17.6 9 11.8l3.8 3.4 6.6-8" />
    <Node cx={9} cy={11.8} />
    <Node cx={12.8} cy={15.2} />
    <Node cx={19.4} cy={7.2} r={1.5} />
  </Icon>
);

/** A torn stub: the notch is the whole idea, so it is cut, not drawn. */
export const IconTickets: EthixIcon = (p) => (
  <Icon {...p}>
    <path d="M3.4 9.6V7.8a2 2 0 0 1 2-2h13.2a2 2 0 0 1 2 2v1.8a2.4 2.4 0 0 0 0 4.8v1.8a2 2 0 0 1-2 2H5.4a2 2 0 0 1-2-2v-1.8a2.4 2.4 0 0 0 0-4.8Z" />
    <Node cx={12} cy={12} />
  </Icon>
);

/** Two slots, one in front of the other -- a conversation, not a notice. */
export const IconMessages: EthixIcon = (p) => (
  <Icon {...p}>
    <path d="M6.6 15.4H5.4a2.4 2.4 0 0 1-2.4-2.4V6.2a2.4 2.4 0 0 1 2.4-2.4h9.2a2.4 2.4 0 0 1 2.4 2.4v1" />
    <rect x="7" y="8.6" width="14" height="9.6" rx="2.4" />
    <path d="M10.6 18.2v2.6l3.2-2.6" />
    <Node cx={17} cy={13.4} />
  </Icon>
);

/** A sheet with its lines set as bars, shortest last. */
export const IconReports: EthixIcon = (p) => (
  <Icon {...p}>
    <rect x="4.6" y="3.2" width="14.8" height="17.6" rx="2.4" />
    <path d="M8.2 9h7.6M8.2 12.8h7.6M8.2 16.6h4.4" />
  </Icon>
);

/** A share taken out of the whole, hinged on a node. */
export const IconBudget: EthixIcon = (p) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.6" />
    <path d="M12 3.4V12h8.6" />
    <Node cx={12} cy={12} />
  </Icon>
);

/** A card, its stripe the same bar the emblem uses. */
export const IconBilling: EthixIcon = (p) => (
  <Icon {...p}>
    <rect x="3.2" y="5.6" width="17.6" height="12.8" rx="2.6" />
    <path d="M3.2 10.2h17.6" />
    <Node cx={7.4} cy={14.6} />
  </Icon>
);

/* -- Integrations -------------------------------------------------------- */

/**
 * ClickUp read in our line: their chevron over the arc it rises from, with
 * the same round joins and cap weight the rest of the set uses.
 */
export const IconClickUp: EthixIcon = (p) => (
  <Icon {...p}>
    <path d="M4.9 11.1 12 4.2l7.1 6.9" />
    <path d="M4.9 16.2Q12 21.4 19.1 16.2" />
  </Icon>
);

/**
 * Slack is already four rounded bars turning about a centre, which is the
 * vocabulary this set is built from -- so it is drawn, not borrowed: outlined
 * like every other glyph here, with the pivot marked as a node.
 */
export const IconSlack: EthixIcon = (p) => (
  <Icon {...p}>
    <rect x="2.4" y="6.6" width="8.2" height="4.8" rx="2.4" />
    <rect x="12.6" y="2.4" width="4.8" height="8.2" rx="2.4" />
    <rect x="6.6" y="13.4" width="4.8" height="8.2" rx="2.4" />
    <rect x="13.4" y="12.6" width="8.2" height="4.8" rx="2.4" />
  </Icon>
);

/* -- Administration ------------------------------------------------------ */

/** Three junctions, linked. People as the web, not as portraits. */
export const IconTeam: EthixIcon = (p) => (
  <Icon {...p}>
    <path d="M7.4 8.2 16.6 8.2M7.9 9.9 11.6 15.6M16.1 9.9 12.4 15.6" />
    <circle cx="7.4" cy="7.4" r="2.6" />
    <circle cx="16.6" cy="7.4" r="2.6" />
    <Node cx={12} cy={17} r={2.6} />
  </Icon>
);

/** A guard with a single way through it. */
export const IconClientAccess: EthixIcon = (p) => (
  <Icon {...p}>
    <path d="M12 3.2 19.4 6v5.6c0 4.6-3.2 7.8-7.4 9.2-4.2-1.4-7.4-4.6-7.4-9.2V6Z" />
    <Node cx={12} cy={11} r={1.6} />
    <path d="M12 12.6v2.4" />
  </Icon>
);

/** The code itself: four places, one already entered. */
export const IconLoginCodes: EthixIcon = (p) => (
  <Icon {...p}>
    <rect x="2.8" y="6" width="18.4" height="12" rx="3" />
    <Node cx={7.4} cy={12} />
    <Node cx={10.8} cy={12} />
    <circle cx="14.2" cy="12" r="1.15" />
    <circle cx="17.6" cy="12" r="1.15" />
  </Icon>
);

/** A slot with its fold creased in. */
export const IconMail: EthixIcon = (p) => (
  <Icon {...p}>
    <rect x="2.8" y="5.4" width="18.4" height="13.2" rx="2.6" />
    <path d="M3.8 7.2l7.1 5.3a1.8 1.8 0 0 0 2.2 0l7.1-5.3" />
  </Icon>
);

/** A proposal and the tick it is waiting on; the node is the second signature. */
export const IconApprovals: EthixIcon = (p) => (
  <Icon {...p}>
    <rect x="3.4" y="3.4" width="17.2" height="17.2" rx="3.4" />
    <path d="M7.8 12.4l2.9 2.9 5.5-5.9" />
    <Node cx={16.2} cy={9.4} />
  </Icon>
);

/** The record: an entry per bar, each one stamped. Only the newest is filled. */
export const IconAuditLog: EthixIcon = (p) => (
  <Icon {...p}>
    <rect x="3.2" y="3.4" width="17.6" height="17.2" rx="2.8" />
    <path d="M10.8 8.2h6.2M10.8 12h6.2M10.8 15.8h4" />
    <Node cx={7.2} cy={8.2} />
    <circle cx="7.2" cy="12" r="1.15" />
    <circle cx="7.2" cy="15.8" r="1.15" />
  </Icon>
);

/* -- Account -------------------------------------------------------------- */

/** A bell reduced to its shell, with the strike as a node. */
export const IconNotifications: EthixIcon = (p) => (
  <Icon {...p}>
    <path d="M6.2 10.4a5.8 5.8 0 0 1 11.6 0c0 3.6 1.4 5.2 1.4 5.2H4.8s1.4-1.6 1.4-5.2Z" />
    <path d="M10.2 18.4a2 2 0 0 0 3.6 0" />
    <Node cx={12} cy={4} />
  </Icon>
);

/** A roof over bars -- the client's own place. */
export const IconHome: EthixIcon = (p) => (
  <Icon {...p}>
    <path d="M3.6 10.6 12 3.6l8.4 7" />
    <path d="M5.8 10.2v8a2 2 0 0 0 2 2h8.4a2 2 0 0 0 2-2v-8" />
    <Node cx={12} cy={15} r={1.5} />
  </Icon>
);
