import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  petChatDecorationSlots,
  type BuiltInPetUiTheme,
  type PetCustomTheme
} from "../../shared/types/pet";
import { ChatThemeDecorations } from "./ChatThemeDecorations";

const themeSignatureIcons: Record<BuiltInPetUiTheme, string> = {
  soft: "lucide-heart",
  rock: "lucide-guitar",
  pixel: "lucide-gamepad2",
  journal: "lucide-feather",
  cyber: "lucide-circuit-board",
  minimal: "lucide-circle"
};

describe("ChatThemeDecorations", () => {
  it.each(Object.entries(themeSignatureIcons) as Array<[BuiltInPetUiTheme, string]>)(
    "renders all four controlled slots for the %s theme",
    (theme, signatureIcon) => {
      const markup = renderToStaticMarkup(<ChatThemeDecorations theme={theme} />);

      for (const slot of petChatDecorationSlots) {
        expect(markup).toContain(`data-slot="${slot}"`);
      }
      expect(markup.match(/data-slot=/g)).toHaveLength(4);
      expect(markup).toContain(signatureIcon);
      expect(markup).toContain('aria-hidden="true"');
    }
  );

  it("keeps a custom theme without decoration declarations undecorated", () => {
    expect(renderToStaticMarkup(<ChatThemeDecorations theme="custom" />)).toBe("");
  });

  it("can render the body watermark independently inside the message viewport", () => {
    const markup = renderToStaticMarkup(
      <ChatThemeDecorations theme="soft" slots={["body-watermark"]} />
    );

    expect(markup).toContain('data-slot="body-watermark"');
    expect(markup).not.toContain('data-slot="frame-top-right"');
  });

  it("renders the controlled icons declared by a custom theme", () => {
    const customTheme = {
      id: "lime-garden",
      name: "青柠花园",
      description: "青柠装饰。",
      version: 4,
      tokens: {
        background: "#f3faee",
        surface: "#f9fdf3",
        text: "#2c3d35",
        mutedText: "#71806f",
        accent: "#82a94e",
        border: "#70914f"
      },
      chatDecorations: {
        "header-left": "citrus",
        "frame-top-right": "citrus",
        "body-watermark": "citrus"
      }
    } satisfies PetCustomTheme;
    const markup = renderToStaticMarkup(
      <ChatThemeDecorations theme="custom" customTheme={customTheme} />
    );

    expect(markup.match(/data-slot=/g)).toHaveLength(3);
    expect(markup).toContain('data-icon="citrus"');
    expect(markup).toContain('data-slot="frame-top-right"');
    expect(markup).toContain('data-slot="header-left"');
    expect(markup).not.toContain('data-slot="header-right"');
    expect(markup).toContain("lucide-citrus");
    expect(markup).not.toContain("lucide-flower2");
  });
});
