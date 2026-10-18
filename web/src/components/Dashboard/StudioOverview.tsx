import { Link } from 'react-router-dom';
import { ArrowUpRight, AudioLines, FileAudio, Headphones, Mic2, Radio, Sparkles } from 'lucide-react';
import type { MeResponse } from '../../api/auth';
import type { Podcast } from '../../api/podcasts';
import styles from './StudioOverview.module.css';

export function StudioOverview({ account, total, podcasts, readOnly, isAdminView }: {
  account?: MeResponse; total: number; podcasts: Podcast[]; readOnly: boolean; isAdminView: boolean;
}) {
  if (isAdminView) return null;
  const recordingShow = podcasts.find(p => {
    const limit = p.maxEpisodes;
    return (p.myRole === 'owner' || p.myRole === 'manager') && (!limit || Number(p.episodeCount ?? 0) < limit);
  });
  const bytes = account?.user.diskBytesUsed;
  const storage = bytes == null ? '—' : bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return <>
    <section className={styles.hero} aria-labelledby="studio-intro">
      <div className={styles.heroCopy}>
        <p className={styles.kicker}><span /> THE ONI PRODUCTION SPACE</p>
        <h2 id="studio-intro">Make something<br /><em>worth hearing.</em></h2>
        <p className={styles.description}>Great conversations deserve a great studio. Bring your people, shape your sound, and put your next story into the world.</p>
        <div className={styles.heroActions}>
          {!readOnly && recordingShow && <Link className={styles.primary} to={`/podcasts/${recordingShow.id}/episodes/new`}><Mic2 size={17} /> Create an episode <ArrowUpRight size={17} /></Link>}
          <Link className={styles.secondary} to="/library"><FileAudio size={17} /> Open sound library</Link>
        </div>
      </div>
      <div className={styles.soundArt} aria-hidden="true">
        <div className={styles.artLabel}><AudioLines size={16} /><span>ONI / SOUND & STORY</span></div>
        <div className={styles.wave}>{Array.from({length: 46}, (_, i) => <i key={i} style={{height: `${18 + Math.abs(Math.sin(i * .63) * Math.cos(i * .17)) * 110}px`}} />)}</div>
        <div className={styles.artFooter}><span>RECORD</span><span>PRODUCE</span><span>PUBLISH</span></div>
      </div>
    </section>
    <section className={styles.stats} aria-label="Your studio totals">
      <div><Radio size={18} /><span>Shows in your workspace<strong>{account?.podcastCount ?? total}</strong></span></div>
      <div><Headphones size={18} /><span>Episodes in your account<strong>{account?.episodeCount ?? '—'}</strong></span></div>
      <div><FileAudio size={18} /><span>Account storage used<strong>{storage}</strong></span></div>
      <div className={styles.community}><Sparkles size={18} /><span>Onyx Interactive Network<strong>Built together.</strong></span></div>
    </section>
  </>;
}
