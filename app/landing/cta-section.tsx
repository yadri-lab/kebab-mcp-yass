export default function CtaSection() {
  const deployUrl =
    "https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FYassinello%2Fmymcp&env=MCP_AUTH_TOKEN,MYMCP_DISPLAY_NAME&envDescription=MCP%20auth%20token%20and%20display%20name%20required%20to%20start.&project-name=my-mcp&repository-name=my-mcp";

  return (
    <section className="py-24 px-6 border-t border-slate-800">
      <div className="max-w-3xl mx-auto text-center">
        <h2 className="text-4xl font-bold text-white mb-4 tracking-tight">Ready in minutes.</h2>
        <p className="text-slate-400 text-lg mb-10 leading-relaxed">
          Deploy your personal MCP server today. Works with Claude Desktop, Cursor, Windsurf, and
          any MCP-compatible client.
        </p>
        <div className="flex flex-col sm:flex-row gap-4 justify-center items-center">
          <a
            href={deployUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 bg-blue-500 hover:bg-blue-400 text-white transition-colors px-8 py-3.5 rounded-lg font-semibold text-sm"
          >
            Deploy to Vercel
          </a>
          <a
            href="https://github.com/Yassinello/mymcp#readme"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 border border-slate-700 text-slate-300 hover:border-slate-500 hover:text-white transition-colors px-8 py-3.5 rounded-lg font-semibold text-sm"
          >
            Read the docs
          </a>
        </div>
      </div>
    </section>
  );
}
