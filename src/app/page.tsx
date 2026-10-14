export default function HomePage() {
  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: "2rem", background: "#f5f7fb", color: "#152033", fontFamily: "Arial, Helvetica, sans-serif" }}>
      <section style={{ width: "min(100%, 760px)", padding: "clamp(1.5rem, 5vw, 3rem)", border: "1px solid #dce3ed", borderRadius: "18px", background: "#ffffff" }}>
        <p style={{ margin: 0, color: "#566a89", fontSize: "0.8rem", letterSpacing: "0.12em" }}>PLATFORM FOUNDATION</p>
        <h1 style={{ margin: "1rem 0", fontSize: "clamp(2rem, 5vw, 3rem)" }}>Bot Platform</h1>
        <p style={{ maxWidth: "58ch", lineHeight: 1.7, color: "#45536a" }}>
          A multi-tenant commerce platform for VPN subscriptions and digital products.
          The initial repository foundation is being established; tenant-facing commerce
          workflows remain unavailable until their domain services and authorization are implemented.
        </p>
        <ul style={{ lineHeight: 1.9, color: "#45536a" }}>
          <li>Next.js App Router application shell</li>
          <li>Prisma data model for tenant-owned records</li>
          <li>Upstash Redis adapter with local development fallback</li>
        </ul>
      </section>
    </main>
  );
}
