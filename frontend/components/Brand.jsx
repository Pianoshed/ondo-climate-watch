import Image from "next/image";
import { APP_NAME } from "../lib/brand";

// Emblem plus app name. The image is decorative (alt="") because the name sits next to it as text.
export default function Brand({ size = 28 }) {
  return (
    <span className="brand">
      <Image src="/icon-192.png" alt="" width={size} height={size} unoptimized priority />
      <span>{APP_NAME}</span>
    </span>
  );
}
