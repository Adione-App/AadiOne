import { Link } from 'react-router-dom'

const variants = {
  primary:
    'bg-leaf-700 text-white hover:bg-leaf-800 shadow-card',
  secondary:
    'bg-white text-ink border border-leaf-200 hover:border-leaf-400 hover:bg-leaf-50',
  ghost: 'text-ink hover:text-leaf-700',
  inverse: 'bg-white text-leaf-800 hover:bg-cream-200',
}

const sizes = {
  md: 'px-5 py-3 text-sm',
  lg: 'px-7 py-4 text-base',
}

export default function Button({
  as = 'button',
  to,
  href,
  variant = 'primary',
  size = 'md',
  className = '',
  children,
  icon: Icon,
  iconPosition = 'right',
  iconClassName = '',
  ...props
}) {
  const classes = `inline-flex items-center justify-center gap-2 rounded-full font-semibold transition-all duration-200 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 ${variants[variant]} ${sizes[size]} ${className}`

  const content = (
    <>
      {Icon && iconPosition === 'left' && <Icon size={18} aria-hidden="true" className={iconClassName} />}
      <span>{children}</span>
      {Icon && iconPosition === 'right' && <Icon size={18} aria-hidden="true" className={iconClassName} />}
    </>
  )

  if (to) {
    return (
      <Link to={to} className={classes} {...props}>
        {content}
      </Link>
    )
  }

  if (href) {
    const external = href.startsWith('http')
    return (
      <a
        href={href}
        target={external ? '_blank' : undefined}
        rel={external ? 'noopener noreferrer' : undefined}
        className={classes}
        {...props}
      >
        {content}
      </a>
    )
  }

  return (
    <button className={classes} {...props}>
      {content}
    </button>
  )
}
