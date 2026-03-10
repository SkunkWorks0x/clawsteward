"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";

const links = [
  { href: "/", label: "Leaderboard" },
  { href: "/about", label: "About" },
];

export default function NavLinks() {
  const pathname = usePathname();

  return (
    <nav className="flex gap-6 text-sm">
      {links.map(({ href, label }) => {
        const isActive = href === "/" ? pathname === "/" : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            className={
              isActive
                ? "text-[#F97316] border-b-2 border-[#F97316] pb-1"
                : "text-[#94A3B8] hover:text-white transition-colors"
            }
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
