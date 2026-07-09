import { Hand, Lock, MessageCircle, Unlock, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { CSSProperties, RefObject } from "react";
import type { PetUiTheme } from "../../shared/types/pet";
import type { PetWindowState } from "../../shared/types/window";

interface RadialPetMenuProps {
  state: PetWindowState;
  position: {
    x: number;
    y: number;
  };
  variant?: PetUiTheme;
  touchEnabled: boolean;
  chatOpen: boolean;
  clickThroughButtonRef: RefObject<HTMLButtonElement>;
  onCloseMenu: () => void;
  onToggleClickThrough: () => void;
  onCloseWindow: () => void;
  onToggleTouch: () => void;
  onToggleChat: () => void;
}

interface RadialMenuAction {
  id: string;
  label: string;
  title: string;
  Icon: LucideIcon;
  tone: "passThrough" | "danger" | "touch" | "chat";
  active?: boolean;
  buttonRef?: RefObject<HTMLButtonElement>;
  onClick: () => void;
}

function getRadialButtonStyle(index: number, count: number): CSSProperties {
  const angle = -90 + (360 / count) * index;

  return {
    "--radial-angle": `${angle}deg`,
    "--radial-counter-angle": `${-angle}deg`,
    "--radial-distance": "68px",
    "--radial-index": index + 1
  } as CSSProperties;
}

export function RadialPetMenu({
  state,
  position,
  variant = "soft",
  touchEnabled,
  chatOpen,
  clickThroughButtonRef,
  onCloseMenu,
  onToggleClickThrough,
  onCloseWindow,
  onToggleTouch,
  onToggleChat
}: RadialPetMenuProps): JSX.Element {
  const actions: RadialMenuAction[] = [
    {
      id: "clickThrough",
      label: state.clickThrough ? "解锁" : "穿透",
      title: state.clickThrough ? "关闭点击穿透" : "开启点击穿透",
      Icon: state.clickThrough ? Unlock : Lock,
      tone: "passThrough",
      active: state.clickThrough,
      buttonRef: clickThroughButtonRef,
      onClick: onToggleClickThrough
    },
    ...(
      state.clickThrough
        ? []
        : [
            {
              id: "close",
              label: "关闭",
              title: "关闭桌宠",
              Icon: X,
              tone: "danger" as const,
              onClick: () => {
                onCloseMenu();
                onCloseWindow();
              }
            },
            {
              id: "touch",
              label: "触控",
              title: touchEnabled ? "关闭触控" : "开启触控",
              Icon: Hand,
              tone: "touch" as const,
              active: touchEnabled,
              onClick: () => {
                onToggleTouch();
                onCloseMenu();
              }
            },
            {
              id: "chat",
              label: "对话",
              title: chatOpen ? "关闭对话" : "打开对话",
              Icon: MessageCircle,
              tone: "chat" as const,
              active: chatOpen,
              onClick: () => {
                onToggleChat();
                onCloseMenu();
              }
            }
          ]
    )
  ];

  return (
    <div
      className="petRadialMenuLayer"
      onContextMenu={(event) => event.preventDefault()}
      onPointerDown={() => {
        if (!state.clickThrough) {
          onCloseMenu();
        }
      }}
    >
      <div
        className={["petRadialMenu", `variant-${variant}`].join(" ")}
        style={
          {
            "--radial-x": `${position.x}px`,
            "--radial-y": `${position.y}px`
          } as CSSProperties
        }
        role="menu"
        aria-label="桌宠快捷菜单"
        onPointerDown={(event) => event.stopPropagation()}
      >
        {!state.clickThrough ? (
          <button
            className="petRadialCenterButton"
            style={{ "--radial-index": 0 } as CSSProperties}
            title="收起菜单"
            type="button"
            onClick={onCloseMenu}
          >
            <X size={16} />
          </button>
        ) : null}
        {actions.map((action, index) => {
          const { Icon } = action;

          return (
            <button
              ref={action.buttonRef}
              className={["petRadialButton", action.tone, action.active ? "active" : ""]
                .filter(Boolean)
                .join(" ")}
              style={getRadialButtonStyle(index, actions.length)}
              title={action.title}
              type="button"
              key={action.id}
              onClick={action.onClick}
            >
              <Icon size={14} />
              <span>{action.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
