import broadFern from "../assets/botanical/fern-broad.webp";
import archingFern from "../assets/botanical/fern-arching.webp";
import fineFern from "../assets/botanical/fern-fine.webp";

/** Decorative museum illustrations; attribution is available from ArtworkCredits. */
export function BotanicalArt({ variant = "garden" }: { variant?: "garden" | "specimen" | "leaves" | "single-specimen" }) {
  return <div className={`botanical-art botanical-art--${variant}`} aria-hidden="true">
    <span className="botanical-art__paper" />
    <span className="botanical-art__scrap" />
    {variant !== "single-specimen" && <img className="botanical-art__leaf botanical-art__leaf--back" src={archingFern} alt="" width="170" height="230" decoding="async" />}
    <img className="botanical-art__leaf botanical-art__leaf--front" src={variant === "specimen" || variant === "single-specimen" ? broadFern : fineFern} alt="" width="150" height="210" decoding="async" />
    <span className="botanical-art__tape" />
  </div>;
}

export function ArtworkCredits() {
  return <a className="artwork-credits" href="/artwork-credits.html" target="_blank" rel="noreferrer">插画来源 ↗</a>;
}
