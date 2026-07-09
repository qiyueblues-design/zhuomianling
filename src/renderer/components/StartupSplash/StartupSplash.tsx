import { APP_NAME } from "../../../shared/constants/app";

interface StartupSplashProps {
  leaving?: boolean;
  statusText?: string;
}

export function StartupSplash({
  leaving = false,
  statusText = "正在唤醒本地桌宠"
}: StartupSplashProps): JSX.Element {
  return (
    <div
      className={`startupSplash${leaving ? " leaving" : ""}`}
      role="status"
      aria-live="polite"
      aria-label={statusText}
    >
      <div className="startupAura" aria-hidden="true" />
      <div className="startupCard">
        <div className="startupMascot" aria-hidden="true">
          <div className="startupScreen">
            <span className="startupScreenGlow" />
          </div>
          <div className="startupSpirit">
            <span className="startupSpiritGlow" />
            <span className="startupAntenna">
              <span className="startupAntennaStem" />
              <span className="startupAntennaSquare outline" />
              <span className="startupAntennaSquare solid" />
            </span>
            <span className="startupEye left" />
            <span className="startupEye right" />
            <span className="startupBlush left" />
            <span className="startupBlush right" />
            <span className="startupPaw left" />
            <span className="startupPaw right" />
            <span className="startupFoot" />
          </div>
          <span className="startupPeekLine" />
        </div>
        <div className="startupCopy">
          <strong>{APP_NAME}</strong>
          <span>{statusText}</span>
        </div>
        <div className="startupProgress" aria-hidden="true">
          <span />
        </div>
      </div>
    </div>
  );
}
