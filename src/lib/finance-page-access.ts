import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { financeAdmin,financeHost } from "@/lib/finance-access";
import { MarketplaceError } from "@/lib/marketplace";
export async function hostFinancePage(manage=false){const session=await auth();if(!session?.user)return null;try{return {...await financeHost(prisma,session.user.id,undefined,manage),userId:session.user.id};}catch(error){if(error instanceof MarketplaceError)return null;throw error;}}
export async function adminFinancePage(){const session=await auth();if(!session?.user)return null;try{return await financeAdmin(prisma,session.user.id);}catch(error){if(error instanceof MarketplaceError)return null;throw error;}}
