import {
  AudioWaveform,
  Binary,
  Blocks,
  Box,
  Circle,
  CircleDashed,
  CircuitBoard,
  Citrus,
  Cpu,
  Feather,
  Flower2,
  Gamepad2,
  Guitar,
  Heart,
  Joystick,
  Leaf,
  Minus,
  Music2,
  NotebookPen,
  ScanLine,
  Sparkles,
  Square,
  Star,
  Zap,
  type LucideIcon
} from "lucide-react";
import {
  petChatDecorationSlots,
  type BuiltInPetUiTheme,
  type PetChatDecorationIcon,
  type PetChatDecorations,
  type PetChatDecorationSlot,
  type PetCustomTheme,
  type PetUiTheme
} from "../../shared/types/pet";

type BuiltInDecorationSet = Record<(typeof petChatDecorationSlots)[number], PetChatDecorationIcon>;

const decorationIcons: Record<PetChatDecorationIcon, LucideIcon> = {
  "audio-waveform": AudioWaveform,
  binary: Binary,
  blocks: Blocks,
  box: Box,
  circle: Circle,
  "circle-dashed": CircleDashed,
  "circuit-board": CircuitBoard,
  citrus: Citrus,
  cpu: Cpu,
  feather: Feather,
  "flower-2": Flower2,
  "gamepad-2": Gamepad2,
  guitar: Guitar,
  heart: Heart,
  joystick: Joystick,
  leaf: Leaf,
  minus: Minus,
  "music-2": Music2,
  "notebook-pen": NotebookPen,
  "scan-line": ScanLine,
  sparkles: Sparkles,
  square: Square,
  star: Star,
  zap: Zap
};

const decorationsByTheme: Record<BuiltInPetUiTheme, BuiltInDecorationSet> = {
  soft: {
    "header-left": "heart",
    "header-right": "sparkles",
    "frame-top-right": "flower-2",
    "body-watermark": "flower-2"
  },
  rock: {
    "header-left": "guitar",
    "header-right": "music-2",
    "frame-top-right": "star",
    "body-watermark": "audio-waveform"
  },
  pixel: {
    "header-left": "gamepad-2",
    "header-right": "joystick",
    "frame-top-right": "box",
    "body-watermark": "blocks"
  },
  journal: {
    "header-left": "feather",
    "header-right": "flower-2",
    "frame-top-right": "leaf",
    "body-watermark": "notebook-pen"
  },
  cyber: {
    "header-left": "circuit-board",
    "header-right": "scan-line",
    "frame-top-right": "cpu",
    "body-watermark": "binary"
  },
  minimal: {
    "header-left": "circle",
    "header-right": "minus",
    "frame-top-right": "square",
    "body-watermark": "circle-dashed"
  }
};

export function getChatThemeDecorations(
  theme: PetUiTheme,
  customTheme?: PetCustomTheme
): PetChatDecorations | undefined {
  return theme === "custom" ? customTheme?.chatDecorations : decorationsByTheme[theme];
}

export function ChatThemeDecorations({
  theme,
  customTheme,
  slots = petChatDecorationSlots
}: {
  theme: PetUiTheme;
  customTheme?: PetCustomTheme;
  slots?: readonly PetChatDecorationSlot[];
}): JSX.Element | null {
  const decorations = getChatThemeDecorations(theme, customTheme);
  if (!decorations || !Object.keys(decorations).length) return null;

  return (
    <div className="petChatDecorations" aria-hidden="true">
      {slots.map((slot) => {
        const iconName = decorations[slot];
        if (!iconName) return null;
        const Icon = decorationIcons[iconName];
        return (
          <span
            className={`petChatDecoration ${slot}`}
            data-icon={iconName}
            data-slot={slot}
            key={slot}
          >
            <Icon strokeWidth={1.8} />
          </span>
        );
      })}
    </div>
  );
}
