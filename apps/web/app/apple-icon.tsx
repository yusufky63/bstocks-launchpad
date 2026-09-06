import fs from "node:fs";
import path from "node:path";
import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/**
 * Home-screen icon: the blue block-B on white — same mark as the favicon, on the one solid
 * ground iOS requires (transparent icons get a black backdrop). Identical in the main app.
 *
 * The source PNG carries transparent padding (mark bbox x19 y33 w218 h190 in 256); drawing the
 * full image at 181px happens to center the visible mark at 154px wide, the size we want.
 */
export default function Icon() {
  let mark: string | null = null;
  try {
    mark = `data:image/png;base64,${fs.readFileSync(path.join(process.cwd(), "public/brand/logo-mark-transparent-256.png")).toString("base64")}`;
  } catch {
    // Missing asset: ship the plain ground rather than fail the route.
  }
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: "#ffffff" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {mark && <img src={mark} alt="" width={181} height={181} style={{ width: 181, height: 181 }} />}
      </div>
    ),
    size,
  );
}
