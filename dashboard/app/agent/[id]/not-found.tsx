import Link from "next/link";

export default function AgentNotFound() {
  return (
    <div className="rounded-xl bg-[#1E293B] p-12 text-center">
      <h1 className="text-xl font-bold text-white">Agent Not Found</h1>
      <p className="mt-2 text-sm text-[#94A3B8]">
        The requested agent does not exist or has been removed.
      </p>
      <Link
        href="/"
        className="mt-4 inline-block text-sm text-[#F97316] hover:underline"
      >
        &larr; Back to Leaderboard
      </Link>
    </div>
  );
}
