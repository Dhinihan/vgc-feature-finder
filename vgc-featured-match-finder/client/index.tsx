import { useAuth, useMutation, useQuery } from "lakebed/client";
import { useMemo, useState } from "preact/hooks";
import type { EventDashboard, RefreshResult } from "../shared/domain";

type UnmatchedPlayer = {
  displayName: string;
  normalizedName: string;
  country: string;
  status: "not-found" | "ambiguous";
  candidates: string[];
};

type RefreshRunRow = {
  id: string;
  startedAt: string;
  finishedAt: string;
  status: string;
  roundNumber: string;
  pairingCount: string;
  unmatchedPlayerCount: string;
  ambiguousPlayerCount: string;
  message: string;
};

type FilterMode = "pending" | "hide-missing" | "top10" | "top25" | "all";

function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

function formatCp(value: number | null): string {
  if (value === null) {
    return "?";
  }

  return formatNumber(value);
}

function formatScore(value: number): string {
  return formatNumber(value);
}

function scoreStatusLabel(status: string): string {
  if (status === "complete") {
    return "completo";
  }
  if (status === "missing-player-cp") {
    return "CP ausente";
  }
  if (status === "bye") {
    return "bye";
  }
  return status;
}

function matchStatusLabel(
  match: EventDashboard["rankedPairings"][number]["playerA"]["championshipPointsMatch"]
): string {
  if (match.status === "not-found") {
    return "CP não encontrado";
  }
  if (match.status === "ambiguous") {
    return "CP ambíguo";
  }
  if (match.status === "manual-override") {
    return "override manual";
  }
  if (match.status === "normalized-name") {
    return "nome normalizado";
  }
  return "CP exato";
}

export function App() {
  const auth = useAuth();
  const dashboard = useQuery<EventDashboard>("eventDashboard");
  const unmatchedPlayers = useQuery<UnmatchedPlayer[]>("unmatchedPlayers");
  const refreshRuns = useQuery<RefreshRunRow[]>("refreshRuns");

  const configureEvent = useMutation<[string, string, string], { eventId: string }>("configureEvent");
  const refreshAll = useMutation<[], RefreshResult>("refreshAll");
  const refreshPairings = useMutation<[], unknown>("refreshPairings");
  const refreshChampionshipPoints = useMutation<[], unknown>("refreshChampionshipPoints");
  const savePlayerOverride = useMutation<[string, string, string, string], void>("savePlayerOverride");

  const [eventInput, setEventInput] = useState("");
  const [division, setDivision] = useState("masters");
  const [filterMode, setFilterMode] = useState<FilterMode>("pending");
  const [showCompleted, setShowCompleted] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [overrideForm, setOverrideForm] = useState({
    tournamentNormalizedName: "",
    tournamentCountry: "*",
    leaderboardNormalizedName: "",
    leaderboardCountry: "*"
  });

  const isAdmin = auth.userId === "vinicius";

  const filteredPairings = useMemo(() => {
    let rows = dashboard.rankedPairings;

    if (!showCompleted && filterMode === "pending") {
      rows = rows.filter((row) => row.isPending);
    } else if (showCompleted) {
      rows = dashboard.rankedPairings;
    }

    if (filterMode === "hide-missing") {
      rows = rows.filter((row) => row.scoreStatus !== "missing-player-cp");
    }

    if (filterMode === "top10") {
      rows = rows.slice(0, 10);
    }

    if (filterMode === "top25") {
      rows = rows.slice(0, 25);
    }

    return rows;
  }, [dashboard.rankedPairings, filterMode, showCompleted]);

  async function onConfigureEvent(event: Event) {
    event.preventDefault();
    if (!isAdmin) {
      setStatusMessage("Somente o administrador pode configurar o evento.");
      return;
    }

    try {
      await configureEvent(eventInput.trim(), "", division);
      setStatusMessage("Evento configurado.");
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Falha ao configurar evento.");
    }
  }

  async function onRefreshAll() {
    if (!isAdmin) {
      setStatusMessage("Somente o administrador pode atualizar.");
      return;
    }

    try {
      setStatusMessage("Atualizando dados...");
      const result = await refreshAll();
      setStatusMessage(
        `Atualização concluída. Rodada ${result.roundNumber}, ${result.pairingsCount} partidas, ${result.championshipPointsCount} jogadores com CP.`
      );
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Falha na atualização.");
    }
  }

  async function onSaveOverride(event: Event) {
    event.preventDefault();
    if (!isAdmin) {
      return;
    }

    try {
      await savePlayerOverride(
        overrideForm.tournamentNormalizedName,
        overrideForm.tournamentCountry,
        overrideForm.leaderboardNormalizedName,
        overrideForm.leaderboardCountry
      );
      setStatusMessage("Override salvo.");
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Falha ao salvar override.");
    }
  }

  function fillOverride(player: UnmatchedPlayer) {
    setOverrideForm({
      tournamentNormalizedName: player.normalizedName,
      tournamentCountry: player.country || "*",
      leaderboardNormalizedName: "",
      leaderboardCountry: "*"
    });
  }

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-8 text-slate-100">
      <div className="mx-auto flex max-w-7xl flex-col gap-8">
        <header className="flex flex-col gap-3 border-b border-slate-800 pb-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm uppercase tracking-[0.2em] text-emerald-400">Lakebed Capsule</p>
              <h1 className="text-3xl font-semibold">VGC Featured Match Finder</h1>
            </div>
            <p className="font-mono text-sm text-slate-400">
              {auth.isLoading ? "carregando sessão..." : `sessão: ${auth.displayName} (${auth.userId})`}
            </p>
          </div>
          <p className="max-w-3xl text-slate-300">
            Identifica as partidas mais relevantes da rodada atual com base no produto dos Championship Points
            dos dois jogadores.
          </p>
        </header>

        <section className="grid gap-4 rounded-xl border border-slate-800 bg-slate-900/60 p-5 md:grid-cols-2 xl:grid-cols-4">
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-400">Evento ativo</p>
            <p className="mt-1 text-lg font-medium">
              {dashboard.event?.title ?? "Nenhum evento configurado"}
            </p>
            <p className="mt-1 text-sm text-slate-400">
              {dashboard.event
                ? `#${dashboard.event.externalEventId} · ${dashboard.event.division}`
                : "Informe um ID ou URL do PokéData"}
            </p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-400">Rodada atual</p>
            <p className="mt-1 text-3xl font-semibold">{dashboard.event?.currentRound ?? "—"}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-400">Última atualização</p>
            <p className="mt-1 text-sm text-slate-200">
              {dashboard.event?.lastRefreshAt
                ? new Date(dashboard.event.lastRefreshAt).toLocaleString()
                : "—"}
            </p>
          </div>
          <div className="flex items-end">
            <button
              type="button"
              className="w-full rounded-lg bg-emerald-500 px-4 py-3 font-medium text-slate-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
              disabled={!isAdmin || !dashboard.event}
              onClick={() => void onRefreshAll()}
            >
              Atualizar
            </button>
          </div>
        </section>

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
          {[
            ["Partidas", dashboard.stats.totalPairings],
            ["Pendentes", dashboard.stats.pendingPairings],
            ["Concluídas", dashboard.stats.completedPairings],
            ["Sem CP", dashboard.stats.unmatchedPlayers],
            ["Ambíguos", dashboard.stats.ambiguousPlayers]
          ].map(([label, value]) => (
            <div key={label} className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
              <p className="text-xs uppercase tracking-wide text-slate-400">{label}</p>
              <p className="mt-2 text-2xl font-semibold">{value}</p>
            </div>
          ))}
        </section>

        <section className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
          <form
            className="rounded-xl border border-slate-800 bg-slate-900/50 p-5"
            onSubmit={(event) => void onConfigureEvent(event)}
          >
            <h2 className="text-lg font-medium">Configurar evento</h2>
            <p className="mt-1 text-sm text-slate-400">
              Use o ID numérico do PokéData ou a URL completa da página de standings.
            </p>
            <div className="mt-4 grid gap-3">
              <input
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2"
                placeholder="0000160 ou URL standingsVGC"
                value={eventInput}
                onInput={(event) => setEventInput(event.currentTarget.value)}
              />
              <select
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2"
                value={division}
                onChange={(event) => setDivision(event.currentTarget.value)}
              >
                <option value="masters">masters</option>
                <option value="seniors">seniors</option>
                <option value="juniors">juniors</option>
              </select>
              <button
                type="submit"
                className="rounded-lg border border-slate-600 px-4 py-2 hover:bg-slate-800 disabled:opacity-50"
                disabled={!isAdmin}
              >
                Salvar evento
              </button>
            </div>
            {!isAdmin ? (
              <p className="mt-3 text-sm text-amber-300">
                Para testar mutações localmente, abra{" "}
                <code className="text-emerald-300">/?lakebed_guest=vinicius</code>.
              </p>
            ) : null}
          </form>

          <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-5">
            <h2 className="text-lg font-medium">Atualizações parciais</h2>
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                className="rounded-lg border border-slate-600 px-3 py-2 text-sm hover:bg-slate-800 disabled:opacity-50"
                disabled={!isAdmin}
                onClick={() => void refreshPairings().then(() => setStatusMessage("Partidas atualizadas."))}
              >
                Atualizar partidas
              </button>
              <button
                type="button"
                className="rounded-lg border border-slate-600 px-3 py-2 text-sm hover:bg-slate-800 disabled:opacity-50"
                disabled={!isAdmin}
                onClick={() =>
                  void refreshChampionshipPoints().then(() =>
                    setStatusMessage("Championship Points atualizados.")
                  )
                }
              >
                Atualizar CPs
              </button>
            </div>
            {statusMessage ? <p className="mt-4 text-sm text-slate-300">{statusMessage}</p> : null}
          </div>
        </section>

        <section className="rounded-xl border border-slate-800 bg-slate-900/50 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-medium">Partidas em destaque</h2>
            <div className="flex flex-wrap gap-2 text-sm">
              {(
                [
                  ["pending", "Somente pendentes"],
                  ["hide-missing", "Ocultar CP ausente"],
                  ["top10", "Top 10"],
                  ["top25", "Top 25"],
                  ["all", "Todas"]
                ] as const
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  className={`rounded-full px-3 py-1 ${
                    filterMode === mode
                      ? "bg-emerald-500 text-slate-950"
                      : "border border-slate-700 text-slate-300"
                  }`}
                  onClick={() => {
                    setFilterMode(mode);
                    setShowCompleted(mode === "all");
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-4 overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="border-b border-slate-800 text-slate-400">
                <tr>
                  <th className="px-3 py-2">Posição</th>
                  <th className="px-3 py-2">Mesa</th>
                  <th className="px-3 py-2">Jogador A</th>
                  <th className="px-3 py-2">CP A</th>
                  <th className="px-3 py-2">Jogador B</th>
                  <th className="px-3 py-2">CP B</th>
                  <th className="px-3 py-2">Score</th>
                  <th className="px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {filteredPairings.map((pairing, index) => (
                  <tr key={pairing.id} className="border-b border-slate-900/80">
                    <td className="px-3 py-3">{index + 1}</td>
                    <td className="px-3 py-3">
                      {pairing.tableNumber ? `Mesa ${pairing.tableNumber}` : "—"}
                    </td>
                    <td className="px-3 py-3">
                      <div>{pairing.playerA.displayName}</div>
                      <div className="text-xs text-slate-500">
                        {matchStatusLabel(pairing.playerA.championshipPointsMatch)}
                      </div>
                    </td>
                    <td className="px-3 py-3">{formatCp(pairing.playerA.championshipPoints)}</td>
                    <td className="px-3 py-3">
                      {pairing.playerB ? (
                        <>
                          <div>{pairing.playerB.displayName}</div>
                          <div className="text-xs text-slate-500">
                            {matchStatusLabel(pairing.playerB.championshipPointsMatch)}
                          </div>
                        </>
                      ) : (
                        "BYE"
                      )}
                    </td>
                    <td className="px-3 py-3">
                      {pairing.playerB ? formatCp(pairing.playerB.championshipPoints) : "—"}
                    </td>
                    <td className="px-3 py-3 font-medium text-emerald-300">
                      {formatScore(pairing.importanceScore)}
                    </td>
                    <td className="px-3 py-3">{scoreStatusLabel(pairing.scoreStatus)}</td>
                  </tr>
                ))}
                {filteredPairings.length === 0 ? (
                  <tr>
                    <td className="px-3 py-6 text-slate-400" colSpan={8}>
                      Nenhuma partida para os filtros atuais.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>

        <section className="grid gap-6 xl:grid-cols-2">
          <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-5">
            <h2 className="text-lg font-medium">Jogadores não associados</h2>
            <div className="mt-4 space-y-3">
              {unmatchedPlayers.map((player) => (
                <div
                  key={`${player.normalizedName}-${player.country}`}
                  className="rounded-lg border border-slate-800 px-4 py-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-medium">{player.displayName}</p>
                      <p className="text-sm text-slate-400">
                        {player.normalizedName} · {player.country || "*"} · {player.status}
                      </p>
                      {player.candidates.length > 0 ? (
                        <p className="mt-1 text-sm text-amber-300">
                          Candidatos: {player.candidates.join(", ")}
                        </p>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      className="rounded-lg border border-slate-600 px-3 py-1 text-sm hover:bg-slate-800"
                      onClick={() => fillOverride(player)}
                    >
                      Corrigir
                    </button>
                  </div>
                </div>
              ))}
              {unmatchedPlayers.length === 0 ? (
                <p className="text-sm text-slate-400">Nenhum jogador pendente de associação.</p>
              ) : null}
            </div>
          </div>

          <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-5">
            <h2 className="text-lg font-medium">Override manual</h2>
            <form className="mt-4 grid gap-3" onSubmit={(event) => void onSaveOverride(event)}>
              <input
                className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2"
                placeholder="nome normalizado do torneio"
                value={overrideForm.tournamentNormalizedName}
                onInput={(event) =>
                  setOverrideForm((current) => ({
                    ...current,
                    tournamentNormalizedName: event.currentTarget.value
                  }))
                }
              />
              <input
                className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2"
                placeholder="país torneio (* se desconhecido)"
                value={overrideForm.tournamentCountry}
                onInput={(event) =>
                  setOverrideForm((current) => ({
                    ...current,
                    tournamentCountry: event.currentTarget.value
                  }))
                }
              />
              <input
                className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2"
                placeholder="nome normalizado do leaderboard"
                value={overrideForm.leaderboardNormalizedName}
                onInput={(event) =>
                  setOverrideForm((current) => ({
                    ...current,
                    leaderboardNormalizedName: event.currentTarget.value
                  }))
                }
              />
              <input
                className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2"
                placeholder="país leaderboard (* se desconhecido)"
                value={overrideForm.leaderboardCountry}
                onInput={(event) =>
                  setOverrideForm((current) => ({
                    ...current,
                    leaderboardCountry: event.currentTarget.value
                  }))
                }
              />
              <button
                type="submit"
                className="rounded-lg bg-slate-100 px-4 py-2 font-medium text-slate-950 disabled:opacity-50"
                disabled={!isAdmin}
              >
                Salvar override
              </button>
            </form>
          </div>
        </section>

        <section className="rounded-xl border border-slate-800 bg-slate-900/50 p-5">
          <h2 className="text-lg font-medium">Últimas execuções de atualização</h2>
          <div className="mt-4 overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="border-b border-slate-800 text-slate-400">
                <tr>
                  <th className="px-3 py-2">Início</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Rodada</th>
                  <th className="px-3 py-2">Partidas</th>
                  <th className="px-3 py-2">Sem CP</th>
                  <th className="px-3 py-2">Ambíguos</th>
                  <th className="px-3 py-2">Mensagem</th>
                </tr>
              </thead>
              <tbody>
                {refreshRuns.map((run) => (
                  <tr key={run.id} className="border-b border-slate-900/80">
                    <td className="px-3 py-3">{new Date(run.startedAt).toLocaleString()}</td>
                    <td className="px-3 py-3">{run.status}</td>
                    <td className="px-3 py-3">{run.roundNumber}</td>
                    <td className="px-3 py-3">{run.pairingCount}</td>
                    <td className="px-3 py-3">{run.unmatchedPlayerCount}</td>
                    <td className="px-3 py-3">{run.ambiguousPlayerCount}</td>
                    <td className="px-3 py-3">{run.message}</td>
                  </tr>
                ))}
                {refreshRuns.length === 0 ? (
                  <tr>
                    <td className="px-3 py-6 text-slate-400" colSpan={7}>
                      Nenhuma execução registrada ainda.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  );
}
