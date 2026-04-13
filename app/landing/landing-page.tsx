import LandingHeader from "./header";
import Hero from "./hero";
import Features from "./features";
import Compatibility from "./compatibility";
import CtaSection from "./cta-section";
import LandingFooter from "./footer";

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <LandingHeader />
      <main>
        <Hero />
        <Features />
        <Compatibility />
        <CtaSection />
      </main>
      <LandingFooter />
    </div>
  );
}
