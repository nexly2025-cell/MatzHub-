export default function Loading() {
  return (
    <div className="shell py-12" aria-label="Loading" role="status">
      <div className="skeleton mb-5 h-10 w-2/5 rounded-xl" />
      <div className="skeleton mb-10 h-4 w-3/5 rounded" />
      <div className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="skeleton aspect-[3/4] rounded-xl" />
        ))}
      </div>
      <span className="sr-only">Loading catalogue</span>
    </div>
  );
}
