import { ImageResponse } from "next/og"

export const size = { width: 32, height: 32 }
export const contentType = "image/png"

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: 32,
          height: 32,
          borderRadius: 7,
          background: "linear-gradient(135deg, #9945FF 0%, #14F195 100%)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {/* Flame shape using text — clean at small sizes */}
        <div
          style={{
            fontSize: 20,
            lineHeight: 1,
            marginTop: -1,
          }}
        >
          🔥
        </div>
      </div>
    ),
    { ...size },
  )
}
