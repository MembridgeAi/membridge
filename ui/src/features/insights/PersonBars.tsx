import { Avatar } from '../../components/Avatar'
import type { Insights } from '../../data/types'

interface PersonBarsProps {
  people: Insights['perPerson']
}

/** "Activity by person" — one bar per teammate, sized relative to whoever
 *  has the most sessions in this window. Matches insights-v4.html's colL
 *  block. No bar at all when the API has nobody to show, rather than an
 *  empty ruled row. */
export function PersonBars({ people }: PersonBarsProps) {
  if (people.length === 0) return null
  const max = Math.max(1, ...people.map(person => person.sessions))

  return (
    <div className="person-bars">
      {people.map(person => (
        <div className="person-row" key={person.id}>
          <span className="person-id">
            <Avatar id={person.id} name={person.name} size={19} />
            <span className="person-name">{person.name}</span>
          </span>
          <span className="person-bar-track">
            <span className="person-bar-fill" style={{ width: `${(person.sessions / max) * 100}%` }} />
          </span>
          <span className="mono person-value">{person.sessions} · {person.shared} shared</span>
        </div>
      ))}
    </div>
  )
}
