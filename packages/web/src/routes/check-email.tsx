import { ArrowRight, Mail } from "lucide-react"
import { Link, useSearchParams } from "react-router-dom"

export function CheckEmail() {
  const [params] = useSearchParams()
  const email = params.get("email") ?? "your email"

  return (
    <div className="min-h-screen flex items-center justify-center p-20">
      <div className="w-[480px] flex flex-col gap-8">
        <div className="flex items-center gap-2.5">
          <span className="w-[18px] h-[18px] bg-accent" aria-hidden />
          <span className="font-display text-[22px] font-semibold text-primary">
            RavenScope
          </span>
        </div>
        <div className="w-14 h-14 border border-border flex items-center justify-center">
          <Mail size={24} className="text-primary" />
        </div>
        <div className="flex flex-col gap-2.5">
          <h1 className="font-display text-[40px] font-medium leading-tight tracking-[-1px] text-primary">
            Check your email
          </h1>
          <p className="text-secondary text-[14px] leading-relaxed">
            We sent a sign-in link to <span className="text-primary">{email}</span>. It
            expires in 15 minutes. Check your inbox — and your spam folder if it's not
            there.
          </p>
        </div>
        <div>
          <Link
            to="/sign-in"
            className="inline-flex items-center gap-1.5 text-secondary hover:text-primary text-[13px] font-display font-medium"
          >
            Use a different email
            <ArrowRight size={14} />
          </Link>
        </div>
      </div>
    </div>
  )
}
