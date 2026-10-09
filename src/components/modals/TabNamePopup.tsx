import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useState } from "react";
import { PremiumPopup, Search, Section, VSpacer } from "../ui/index.js";
import { fitPopupWidth } from "../ui/popup-geometry.js";

const NAME_MAX = 30;

interface Props {
  visible: boolean;
  placeholder: string;
  onSubmit: (name: string) => void;
  onClose: () => void;
}

export function TabNamePopup({ visible, placeholder, onSubmit, onClose }: Props) {
  const { width: tw } = useTerminalDimensions();
  const [value, setValue] = useState("");

  useEffect(() => {
    if (visible) setValue("");
  }, [visible]);

  useKeyboard((evt) => {
    if (!visible) return;
    if (evt.name === "escape") {
      onClose();
      evt.preventDefault();
      return;
    }
    if (evt.name === "return") {
      onSubmit(value.trim());
      evt.preventDefault();
      return;
    }
    if (evt.name === "backspace" || evt.name === "delete") {
      setValue((p) => p.slice(0, -1));
      evt.preventDefault();
      return;
    }
    const ch = evt.sequence;
    if (typeof ch === "string" && ch.length === 1 && ch >= " " && !evt.ctrl && !evt.meta) {
      setValue((p) => (p.length >= NAME_MAX ? p : p + ch));
    }
    evt.preventDefault();
  });

  if (!visible) return null;

  const popupW = fitPopupWidth(Math.min(56, Math.max(44, Math.floor(tw * 0.45))), tw);

  return (
    <PremiumPopup
      visible={visible}
      width={popupW}
      height={11}
      title="New Tab"
      titleIcon="tabs"
      blurb="Give this tab a name"
      footerHints={[
        { key: "Enter", label: "create" },
        { key: "Esc", label: "cancel" },
      ]}
    >
      <Section>
        <Search value={value} focused={true} placeholder={placeholder} icon="pencil" />
        <VSpacer />
      </Section>
    </PremiumPopup>
  );
}
