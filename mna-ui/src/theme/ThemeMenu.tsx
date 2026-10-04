import { Monitor, Moon, Sun } from "lucide-react";
import SelectField from "../ui/SelectField";
import {
  setThemePreference,
  useTheme,
  type ThemePreference,
} from "../lib/theme-store";

export default function ThemeMenu() {
  const { preference } = useTheme();
  const Icon =
    preference === "system" ? Monitor : preference === "dark" ? Moon : Sun;
  return (
    <SelectField
      className="theme-control"
      label="Appearance"
      value={preference}
      onChange={(value) => setThemePreference(value as ThemePreference)}
      icon={<Icon size={15} />}
      options={[
        {
          value: "system",
          label: "System",
          description: "Follow your device",
          icon: <Monitor size={16} />,
        },
        {
          value: "light",
          label: "Light",
          description: "Light surfaces",
          icon: <Sun size={16} />,
        },
        {
          value: "dark",
          label: "Dark",
          description: "Dark surfaces",
          icon: <Moon size={16} />,
        },
      ]}
    />
  );
}
