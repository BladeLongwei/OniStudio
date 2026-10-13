import { useQueries } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Headphones } from 'lucide-react';
import { listEpisodes } from '../../api/episodes';
import type { Podcast } from '../../api/podcasts';
import styles from './StudioRecentEpisodes.module.css';

export function StudioRecentEpisodes({ podcasts }: { podcasts: Podcast[] }) {
  const results = useQueries({ queries: podcasts.map(p => ({
    queryKey: ['episodes', p.id], queryFn: () => listEpisodes(p.id), staleTime: 30_000,
  })) });
  const recent = results.flatMap((r, i) => (r.data ?? []).map(episode => ({ episode, show: podcasts[i] })))
    .sort((a, b) => Date.parse(b.episode.updatedAt || b.episode.createdAt) - Date.parse(a.episode.updatedAt || a.episode.createdAt)).slice(0, 3);
  if (!podcasts.length || !recent.length) return null;
  return <section className={styles.section} aria-labelledby="studio-recent-title">
    <div className={styles.heading}><h2 id="studio-recent-title">Back to the work</h2><span>Recently updated in the shows below</span></div>
    <div className={styles.grid}>{recent.map(({episode, show}) => <Link key={episode.id} to={`/episodes/${episode.id}`} className={styles.project}>
      <div className={styles.top}><Headphones size={17} /><span className={styles.status}>{episode.status}</span><ArrowUpRight size={16} /></div>
      <h3>{episode.title}</h3><p>{show.title}</p><span className={styles.open}>Open production workspace →</span>
    </Link>)}</div>
  </section>;
}
