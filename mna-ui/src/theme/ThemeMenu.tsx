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
        { value: "system", label: "System", icon: <Monitor size={16} /> },
        { value: "light", label: "Light", icon: <Sun size={16} /> },
        { value: "dark", label: "Dark", icon: <Moon size={16} /> },
      ]}
    />
  );
}
